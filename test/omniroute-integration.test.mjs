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

function chatText(body) {
  return (body.messages || [])
    .flatMap((message) => Array.isArray(message.content) ? message.content : [message.content])
    .map((part) => typeof part === "string" ? part : part?.text || "")
    .join("\n");
}

test(
  "Codex Responses reaches only the exact acknowledged OmniRoute model through the real gateway",
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
      const text = chatText(body);
      if (text.includes("ERROR_MARKER")) {
        response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" });
        response.end(JSON.stringify({ error: { message: "fake broker quota" } }));
        return;
      }
      if (body.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl_zodex_stream",
          object: "chat.completion.chunk",
          model: UPSTREAM_MODEL,
          choices: [{ index: 0, delta: { role: "assistant", content: "OMNIROUTE_STREAM_OK" } }],
        })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      const message = Array.isArray(body.tools) && body.tools.length
        ? {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_zodex_contract",
              type: "function",
              function: { name: "lookup_fixture", arguments: '{"item":"zodex"}' },
            }],
          }
        : { role: "assistant", content: "OMNIROUTE_TEXT_OK" };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl_zodex_contract",
        object: "chat.completion",
        model: UPSTREAM_MODEL,
        choices: [{ index: 0, message, finish_reason: body.tools?.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
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

      const streamResponse = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ROUTER_MODEL, input: "STREAM_MARKER", stream: true }),
      });
      const streamBody = await streamResponse.text();
      assert.equal(streamResponse.status, 200, `${streamBody}\n${stackOutput}`);
      assert.match(streamBody, /OMNIROUTE_STREAM_OK/);

      const errorResponse = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ROUTER_MODEL, input: "ERROR_MARKER", stream: false }),
      });
      const errorBody = await errorResponse.text();
      assert.equal(errorResponse.status, 429, `${errorBody}\n${stackOutput}`);
      assert.match(errorBody, /fake broker quota|rate limit|quota/iu);

      assert.equal(
        received.filter(({ body }) => chatText(body).includes("TOOL_IMAGE_MARKER")).length,
        1,
      );
      assert.equal(
        received.filter(({ body }) => chatText(body).includes("STREAM_MARKER")).length,
        1,
      );
      assert.ok(
        received.filter(({ body }) => chatText(body).includes("ERROR_MARKER")).length >= 1,
        "the gateway may retry a 429, but only against the same exact model",
      );
      assert.deepEqual(
        [...new Set(received.map(({ body }) => body.model))],
        [UPSTREAM_MODEL],
        "no retry may substitute or fall back to another model",
      );
      for (const request of received) {
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.body.model, UPSTREAM_MODEL);
        assert.equal(request.headers.authorization, `Bearer ${ENDPOINT_KEY}`);
        assert.equal(request.headers["chatgpt-account-id"], undefined);
        assert.notEqual(request.headers.authorization, `Bearer ${INTERNAL_KEY}`);
      }
      assert.ok(
        received[0].body.messages.some((message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part?.type === "image_url")
        ),
        "image input should reach an image-capable curated model",
      );
      assert.equal(received[0].body.tools[0].function.name, "lookup_fixture");
    } finally {
      await stopProcess(stack);
      await new Promise((resolve) => mock.close(resolve));
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
