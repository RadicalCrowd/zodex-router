import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { secretEqual } from "./caller-auth.mjs";
import { TARGET } from "./paths.mjs";

export const MAX_BODY_BYTES = Number(
  process.env.MODEL_ROUTER_MAX_BODY_BYTES ||
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_MAX_BODY_BYTES || process.env.KIMI_PROXY_MAX_BODY_BYTES
      : undefined) ||
    64 * 1024 * 1024,
);

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Node closes an idle keep-alive connection after 5 seconds and advertises
// that as `Keep-Alive: timeout=5`. Codex's HTTP client (hyper) never reads
// that header and pools idle sockets for 90 seconds, so every gap longer than
// five seconds — a tool call, a turn boundary, roughly a third of this
// router's traffic — leaves the client holding a socket the server has
// already closed. A request written into that window is answered with a FIN
// instead of a response, which surfaces to the user as
// `stream disconnected before completion: error sending request for url`.
// The server has to be the side that outlasts the pool, so hold idle
// connections past any plausible client idle timeout instead.
export const KEEPALIVE_TIMEOUT_MS = 120_000;

// Node runs the headers timer over keep-alive idle time as well, so a
// `headersTimeout` below `keepAliveTimeout` destroys connections the server
// otherwise intends to keep. Derive it rather than letting the two drift.
export const HEADERS_TIMEOUT_MS = KEEPALIVE_TIMEOUT_MS + 5_000;

export function applyKeepAliveTimeouts(server) {
  server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

export async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

// The transport reports every connection-level failure as a bare
// `TypeError: fetch failed`; the code that says why (ECONNREFUSED,
// UND_ERR_CONNECT_TIMEOUT, ENOTFOUND, ...) lives on the `cause` chain, and a
// log line that stops at the top error is what left #171's repeated native
// failures unexplainable from the retained log. Walk the chain and name every
// link. Services whose failures can wrap upstream response text pass
// `messages: false` and record names and codes only, which never carry a body.
const MAX_ERROR_CHAIN_DEPTH = 8;

export function formatErrorChain(error, { messages = true } = {}) {
  const parts = [];
  let current = error;
  for (
    let depth = 0;
    current !== undefined && current !== null && depth < MAX_ERROR_CHAIN_DEPTH;
    depth += 1
  ) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const name = typeof current.name === "string" && current.name ? current.name : "Error";
    const message =
      messages && typeof current.message === "string" && current.message
        ? `: ${current.message}`
        : "";
    const code = current.code !== undefined ? ` (${current.code})` : "";
    parts.push(`${name}${message}${code}`);
    // AggregateError (a dual-stack connect failure) links its members through
    // `errors` rather than `cause`; the first member names the socket failure.
    current = current.cause ?? (Array.isArray(current.errors) ? current.errors[0] : undefined);
  }
  return parts.length ? parts.join(" <- ") : String(error);
}

export function httpErrorStatus(error, fallback = 502) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : fallback;
}

export function copyResponseHeaders(upstream, response, denylist = HOP_BY_HOP_HEADERS) {
  for (const [name, value] of upstream.headers.entries()) {
    if (!denylist.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

function isEventStream(response) {
  return String(response.getHeader("content-type") || "")
    .toLowerCase()
    .includes("text/event-stream");
}

export async function finishResponse(response) {
  return new Promise((resolve) => {
    if (response.writableFinished || response.destroyed) {
      resolve();
      return;
    }
    response.once("finish", resolve);
    // A client that hangs up before the last chunk drains emits "close"
    // without "finish"; the request is over either way.
    response.once("close", resolve);
    if (!response.writableEnded) response.end();
  });
}

// Terminate a response whose body is already streaming.
//
// `response.destroy()` resets the socket, so an in-flight chunked body loses
// its terminating `0\r\n\r\n` and the client reports a transport failure
// ("error decoding response body") with nothing to say about the cause. Ending
// the body instead produces a well-formed, if short, HTTP message.
//
// A gracefully ended SSE stream, though, is indistinguishable from a completed
// one: the turn would simply look short and successful. So on `text/event-stream`
// we first emit a terminal `error` event, matching the event framing the router
// already writes elsewhere and the Responses API's own `error` event. A parser
// that understands it surfaces a real failure; one that does not ignores the
// unknown event and lands on the plain graceful end, which is still strictly
// better than a reset. The frame carries a fixed router-side message and never
// upstream error text, so no response body can leak through it.
//
// The frame is prefixed with a blank line because the stream is being ended at
// the point upstream died, which is very often mid-line: transforms forward
// upstream's chunk boundaries verbatim, and a single `output_text.delta` can
// carry a long span. Writing `event: error` straight onto an unterminated
// `data:` line does not produce an error event at all -- a conforming parser
// reads the field name as more of the previous event's data, so the failure
// signal turns into garbage appended to the last delta, which is exactly the
// silent corruption this function exists to avoid. Leading newlines are inert
// when the stream did end cleanly: a blank line with no buffered fields
// dispatches nothing.
export function endStreamedResponse(response) {
  if (!response || response.writableEnded || response.destroyed) return;
  writeStreamErrorEvent(response, {
    code: "local_router_stream_failed",
    message: "The local router lost the upstream response stream.",
  });
  response.end();
}

// Emit a terminal `error` event into a response whose head is already sent,
// without ending it -- the caller decides when the stream is over. Used where
// the router has committed to a 200 and then hits a failure it must state
// rather than let pass as a short, successful-looking turn. The framing and
// the leading blank line are the same as `endStreamedResponse` above, and for
// the same reasons; the message is always router-side text, never an upstream
// body.
export function writeStreamErrorEvent(response, { code, message }) {
  if (!response || response.writableEnded || response.destroyed) return false;
  if (!isEventStream(response)) return false;
  try {
    const data = { type: "error", code, message, param: null };
    response.write(`\n\nevent: error\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    // The socket may already be gone; the caller ends the response anyway.
    return false;
  }
}

export async function pipeResponse(
  upstream,
  response,
  denylist,
  transform,
  { leaveOpen = false, signal } = {},
) {
  const transforms = transform === undefined
    ? []
    : Array.isArray(transform)
      ? transform
      : [transform];
  response.statusCode = upstream.status;
  copyResponseHeaders(upstream, response, denylist);
  if (!upstream.body) {
    if (!leaveOpen) response.end();
    return;
  }
  const source = Readable.fromWeb(upstream.body);
  try {
    // `pipeline` forwards errors and destroys every stream in the chain, which
    // `.pipe()` does not: a mid-stream upstream failure used to leave the
    // response half-written and open forever. `end: false` keeps the response
    // itself out of that teardown so the caller can end the body cleanly (see
    // `endStreamedResponse`) instead of resetting the socket.
    await pipeline(source, ...transforms, response, {
      end: false,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // A client that disconnects mid-stream destroys the response, which
    // pipeline reports as a premature close. That is not a router failure, and
    // pipeline has already torn the upstream read down, so the in-flight
    // counter releases without inventing an error.
    if (response.destroyed && !response.writableFinished) return;
    throw error;
  }
  // `leaveOpen` lets the caller keep the response writable after the upstream
  // stream ends so an empty completion can be retried against the same
  // response; the caller is responsible for ending it (see finishResponse).
  if (!leaveOpen) await finishResponse(response);
}

export function requireInternalAuth(request, response, secret) {
  const authorized = secretEqual(
    request.headers.authorization,
    `Bearer ${secret}`,
  ) || secretEqual(request.headers["x-api-key"], secret);
  if (!authorized) {
    writeJson(response, 401, {
      error: {
        type: "authentication_error",
        message: "This internal loopback route requires the router service key.",
      },
    });
  }
  return authorized;
}
