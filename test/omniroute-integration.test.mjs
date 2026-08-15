import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledLiteLlm = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "litellm.exe" : "litellm",
);
const liteLlm = process.env.MODEL_ROUTER_LITELLM_BIN || bundledLiteLlm;
const enabled = process.env.MODEL_ROUTER_LITELLM_INTEGRATION === "1";
const INTERNAL_KEY = "omniroute-e2e-internal-service-key-with-sufficient-length";
const CALLER_KEY = "omniroute-e2e-caller-capability-with-sufficient-length";
const ENDPOINT_KEY = "omniroute-e2e-local-endpoint-key";
const UPSTREAM_MODEL = "cc/claude-zodex-contract";
const ROUTER_MODEL = `omniroute-oauth/${UPSTREAM_MODEL}`;

async function freePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function waitForRouter(port, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Integration stack exited early: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The isolated stack is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for the integration stack: ${output()}`);
}

function payloadText(body) {
  const rows = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : body.input === undefined
        ? []
        : [body.input];
  return rows
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item?.type === "function_call_output") return [item.output];
      return Array.isArray(item?.content) ? item.content : [item?.content];
    })
    .map((part) => typeof part === "string" ? part : part?.text || "")
    .join("\n");
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

test(
  "Codex Responses reaches only the exact acknowledged OmniRoute model through its Responses surface",
  {
    skip: !enabled
      ? "set MODEL_ROUTER_LITELLM_INTEGRATION=1 for the pinned-adapter integration test"
      : !existsSync(liteLlm)
        ? "run ./install.sh --target codex --prepare-only first"
        : false,
    timeout: 90_000,
  },
  async (context) => {
    const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort] = await freePorts(5);
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "zodex-omniroute-e2e-"));
    const stateDir = path.join(testRoot, "state");
    const configFile = path.join(testRoot, "zodex-config.json");
    const userModels = path.join(testRoot, "user-models.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(stateDir, "internal-secret"), `${INTERNAL_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
    writeFileSync(
      path.join(stateDir, "omniroute-endpoint-key.secret"),
      `${ENDPOINT_KEY}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["kilo-free", "opencode-free"] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      configFile,
      `${JSON.stringify({
        version: 1,
        oauth: {
          brokers: {
            omniroute: {
              enabled: true,
              providers: {
                anthropic: {
                  enabled: true,
                  acknowledgements: ["zodex-oauth-risk-v1", "zodex-oauth-effects-v1"],
                },
              },
            },
          },
        },
        remoteControl: { enabled: false, extensions: [] },
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      userModels,
      `${JSON.stringify({
        version: 1,
        models: [{
          slug: ROUTER_MODEL,
          gatewayModel: "omniroute-oauth-cc-claude-zodex-contract",
          upstreamModel: UPSTREAM_MODEL,
          provider: "omniroute-oauth",
          listed: true,
          displayName: "Claude Zodex contract fixture",
          description: "Isolated fake-broker fixture.",
          priority: 500,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
          contextWindow: 131072,
          autoCompact: 110000,
          inputModalities: ["text", "image"],
          compHash: "omniroute-oauth-cc-claude-zodex-contract-user-v1",
        }],
      })}\n`,
      { mode: 0o600 },
    );

    const received = [];
    let cancellationObserved = false;
    const mock = http.createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: UPSTREAM_MODEL }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      received.push({ url: request.url, headers: request.headers, body });
      const text = payloadText(body);
      if (text.includes("ERROR_MARKER")) {
        response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" });
        response.end(JSON.stringify({ error: { message: "fake broker quota" } }));
        return;
      }
      if (text.includes("CANCEL_MARKER")) {
        let heartbeat;
        const markCanceled = () => {
          cancellationObserved = true;
          clearInterval(heartbeat);
        };
        request.once("aborted", markCanceled);
        response.once("close", markCanceled);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: {
            id: "resp_zodex_cancel",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "in_progress",
            model: UPSTREAM_MODEL,
            output: [],
          },
        })}\n\n`);
        response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: "msg_zodex_cancel",
          output_index: 0,
          content_index: 0,
          delta: "CANCEL_STARTED",
        })}\n\n`);
        heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25);
        return;
      }
      if (body.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: {
            id: "resp_zodex_stream",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "in_progress",
            model: UPSTREAM_MODEL,
            output: [],
          },
        })}\n\n`);
        response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: "msg_zodex_stream",
          output_index: 0,
          content_index: 0,
          delta: "OMNIROUTE_STREAM_OK",
        })}\n\n`);
        response.write(`event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_zodex_stream",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            model: UPSTREAM_MODEL,
            output: [{
              id: "msg_zodex_stream",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "OMNIROUTE_STREAM_OK", annotations: [] }],
            }],
            usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
          },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      const output = Array.isArray(body.tools) && body.tools.length
        ? [{
            id: "fc_zodex_contract",
            type: "function_call",
            call_id: "call_zodex_contract",
            name: "lookup_fixture",
            arguments: '{"item":"zodex"}',
            status: "completed",
          }]
        : [{
            id: "msg_zodex_contract",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "OMNIROUTE_TEXT_OK", annotations: [] }],
          }];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_zodex_contract",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: UPSTREAM_MODEL,
        output,
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      }));
    });
    try {
      await new Promise((resolve, reject) => {
        mock.once("error", reject);
        mock.listen(20128, "127.0.0.1", resolve);
      });
    } catch (error) {
      rmSync(testRoot, { recursive: true, force: true });
      if (error?.code === "EADDRINUSE") {
        context.skip("127.0.0.1:20128 is already occupied");
        return;
      }
      throw error;
    }

    const stack = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_USER_MODELS: userModels,
        MODEL_ROUTER_PORT: String(routerPort),
        MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
        MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
        MODEL_ROUTER_API_PORT: String(apiPort),
        MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
        MODEL_ROUTER_LITELLM_BIN: liteLlm,
        ZODEX_CONFIG_FILE: configFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stackOutput = "";
    stack.stdout.setEncoding("utf8");
    stack.stderr.setEncoding("utf8");
    stack.stdout.on("data", (chunk) => { stackOutput += chunk; });
    stack.stderr.on("data", (chunk) => { stackOutput += chunk; });

    try {
      await waitForRouter(routerPort, stack, () => stackOutput);
      const base = callerBaseUrl(routerPort, CALLER_KEY);
      const toolResponse = await fetch(`${base}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ChatGPT-Account-Id": "must-not-forward",
        },
        body: JSON.stringify({
          model: ROUTER_MODEL,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: "TOOL_IMAGE_MARKER" },
              { type: "input_image", image_url: "data:image/png;base64,AA==" },
            ],
          }],
          tools: [{
            type: "function",
            name: "lookup_fixture",
            description: "Look up a fixture",
            parameters: {
              type: "object",
              properties: { item: { type: "string" } },
              required: ["item"],
              additionalProperties: false,
            },
          }],
          stream: false,
        }),
      });
      const toolBody = await toolResponse.text();
      assert.equal(toolResponse.status, 200, `${toolBody}\n${stackOutput}`);
      assert.match(toolBody, /lookup_fixture/);

      const toolResultResponse = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ROUTER_MODEL,
          input: [
            {
              type: "function_call",
              call_id: "call_zodex_contract",
              name: "lookup_fixture",
              arguments: '{"item":"zodex"}',
            },
            {
              type: "function_call_output",
              call_id: "call_zodex_contract",
              output: "TOOL_RESULT_MARKER",
            },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "continue after the tool result" }],
            },
          ],
          stream: false,
        }),
      });
      const toolResultBody = await toolResultResponse.text();
      assert.equal(toolResultResponse.status, 200, `${toolResultBody}\n${stackOutput}`);
      assert.match(toolResultBody, /OMNIROUTE_TEXT_OK/);

      const reasoningResponse = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ROUTER_MODEL,
          input: "REASONING_MARKER",
          reasoning: { effort: "high" },
          stream: false,
        }),
      });
      const reasoningBody = await reasoningResponse.text();
      assert.equal(reasoningResponse.status, 200, `${reasoningBody}\n${stackOutput}`);
      assert.match(reasoningBody, /OMNIROUTE_TEXT_OK/);

      const compactResponse = await fetch(`${base}/responses/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ROUTER_MODEL,
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "COMPACTION_MARKER" }],
          }],
        }),
      });
      const compactBody = await compactResponse.text();
      assert.equal(compactResponse.status, 200, `${compactBody}\n${stackOutput}`);
      assert.match(compactBody, /OMNIROUTE_TEXT_OK/);

      const streamResponse = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ROUTER_MODEL, input: "STREAM_MARKER", stream: true }),
      });
      const streamBody = await streamResponse.text();
      assert.equal(streamResponse.status, 200, `${streamBody}\n${stackOutput}`);
      assert.match(streamBody, /OMNIROUTE_STREAM_OK/);

      const cancelUrl = new URL(`${base}/responses`);
      await new Promise((resolve, reject) => {
        const request = http.request(
          {
            host: cancelUrl.hostname,
            port: cancelUrl.port,
            path: cancelUrl.pathname,
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (response) => {
            response.once("data", () => {
              response.socket.destroy();
              resolve();
            });
          },
        );
        request.once("error", (error) => {
          if (error?.code === "ECONNRESET") resolve();
          else reject(error);
        });
        request.end(JSON.stringify({
          model: ROUTER_MODEL,
          input: "CANCEL_MARKER",
          stream: true,
        }));
      });
      await waitFor(
        () => cancellationObserved,
        `client cancellation did not propagate through Router and the API forwarder; ` +
          `cancel_requests=${received.filter(({ body }) => payloadText(body).includes("CANCEL_MARKER")).length}; ` +
          `stack=${stackOutput}`,
      );

      const errorResponse = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ROUTER_MODEL, input: "ERROR_MARKER", stream: false }),
      });
      const errorBody = await errorResponse.text();
      assert.equal(errorResponse.status, 429, `${errorBody}\n${stackOutput}`);
      assert.match(errorBody, /fake broker quota|rate limit|quota/iu);

      assert.equal(
        received.filter(({ body }) => payloadText(body).includes("TOOL_IMAGE_MARKER")).length,
        1,
      );
      assert.equal(
        received.filter(({ body }) => payloadText(body).includes("STREAM_MARKER")).length,
        1,
      );
      assert.equal(
        received.filter(({ body }) => payloadText(body).includes("REASONING_MARKER")).length,
        1,
      );
      assert.equal(
        received.filter(({ body }) => payloadText(body).includes("COMPACTION_MARKER")).length,
        1,
      );
      assert.equal(
        received.filter(({ body }) => payloadText(body).includes("CANCEL_MARKER")).length,
        1,
      );
      assert.ok(
        received.filter(({ body }) => payloadText(body).includes("ERROR_MARKER")).length >= 1,
        "the gateway may retry a 429, but only against the same exact model",
      );
      assert.deepEqual(
        [...new Set(received.map(({ body }) => body.model))],
        [UPSTREAM_MODEL],
        "no retry may substitute or fall back to another model",
      );
      for (const request of received) {
        assert.equal(request.url, "/v1/responses");
        assert.equal(request.body.model, UPSTREAM_MODEL);
        assert.equal(request.headers.authorization, `Bearer ${ENDPOINT_KEY}`);
        assert.equal(request.headers["chatgpt-account-id"], undefined);
        assert.notEqual(request.headers.authorization, `Bearer ${INTERNAL_KEY}`);
      }
      assert.ok(
        received[0].body.input.some((message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part?.type === "input_image")
        ),
        "image input should reach an image-capable curated model",
      );
      assert.equal(received[0].body.tools[0].name, "lookup_fixture");
      const toolResultRequest = received.find(({ body }) =>
        payloadText(body).includes("continue after the tool result")
      );
      assert.ok(toolResultRequest);
      assert.ok(toolResultRequest.body.input.some((item) =>
        item.type === "function_call_output" &&
        item.call_id === "call_zodex_contract" &&
        item.output === "TOOL_RESULT_MARKER"
      ));
      const reasoningRequest = received.find(({ body }) =>
        payloadText(body).includes("REASONING_MARKER")
      );
      assert.ok(reasoningRequest);
      assert.equal(reasoningRequest.body.reasoning.effort, "high");
    } finally {
      await stopProcess(stack);
      await new Promise((resolve) => mock.close(resolve));
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
