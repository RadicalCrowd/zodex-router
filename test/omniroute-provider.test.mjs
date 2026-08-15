import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PROVIDERS, MODELS } from "../src/model-registry.mjs";
import { modelIds } from "../src/model-discovery.mjs";
import { providerAccountUsageSnapshot } from "../src/provider-account-usage.mjs";
import {
  directOmnirouteModelIds,
  isDirectOmnirouteModelId,
  omnirouteLoopbackProblem,
  probeOmniroute,
} from "../src/omniroute-broker.mjs";

test("OmniRoute is a catalog-only loopback provider with an isolated endpoint key", () => {
  const provider = PROVIDERS.get("omniroute-oauth");
  assert.equal(provider.displayName, "OmniRoute OAuth Broker");
  assert.equal(provider.kind, "openai-compatible");
  assert.equal(provider.protocol, "openai-responses");
  assert.equal(provider.baseUrl, "http://127.0.0.1:20128/v1");
  assert.equal(provider.baseUrlEnv, undefined);
  assert.equal(provider.credential.file, "omniroute-endpoint-key.secret");
  assert.deepEqual(provider.credential.environment, ["OMNIROUTE_API_KEY"]);
  assert.deepEqual(provider.credential.keychainServices, ["zodex-router-omniroute-endpoint"]);
  assert.equal(MODELS.some(({ provider: id }) => id === provider.id), false);
});

test("OmniRoute base URL rejects remote, alternate-port, and TLS endpoints", () => {
  assert.equal(omnirouteLoopbackProblem("http://127.0.0.1:20128/v1"), undefined);
  assert.match(omnirouteLoopbackProblem("http://0.0.0.0:20128/v1"), /127\.0\.0\.1/);
  assert.match(omnirouteLoopbackProblem("http://127.0.0.1:4202/v1"), /20128/);
  assert.match(omnirouteLoopbackProblem("https://127.0.0.1:20128/v1"), /plain HTTP/);
});

test("model discovery preserves explicit direct ids and rejects routing constructs", () => {
  assert.equal(isDirectOmnirouteModelId("cc/claude-opus-4-1"), true);
  assert.equal(isDirectOmnirouteModelId("gemini/gemini-2.5-pro"), true);
  assert.equal(isDirectOmnirouteModelId("claude-opus-4-1"), false);
  assert.equal(isDirectOmnirouteModelId("auto/claude"), false);
  assert.equal(isDirectOmnirouteModelId("cc/claude-auto"), false);
  assert.deepEqual(
    directOmnirouteModelIds({
      data: [
        { id: "gemini/gemini-2.5-pro" },
        { id: "cc/claude-opus-4-1" },
        { id: "cc/claude-opus-4-1" },
        { id: "auto/claude" },
        { id: "bare-model" },
      ],
    }),
    ["cc/claude-opus-4-1", "gemini/gemini-2.5-pro"],
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "omniroute-discovery-policy-"));
  const file = path.join(root, "config.json");
  process.env.ZODEX_CONFIG_FILE = file;
  try {
    writeFileSync(file, `${JSON.stringify({
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
    })}\n`, { mode: 0o600 });
    assert.deepEqual(
      modelIds(
        { data: [{ id: "cc/claude-opus-4-1" }, { id: "auto/claude" }, { id: "bare-model" }] },
        PROVIDERS.get("omniroute-oauth"),
      ),
      ["cc/claude-opus-4-1"],
    );
  } finally {
    delete process.env.ZODEX_CONFIG_FILE;
    rmSync(root, { recursive: true, force: true });
  }
});

test("OmniRoute account usage never polls an upstream billing endpoint", async () => {
  process.env.OMNIROUTE_API_KEY = "TEST_ONLY_ENDPOINT_KEY";
  let called = false;
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["omniroute-oauth"],
      fetchImpl: async () => {
        called = true;
        throw new Error("OmniRoute usage must stay local-only");
      },
    });
    assert.equal(called, false);
    assert.equal(snapshot["omniroute-oauth"].status, "local-only");
    assert.match(snapshot["omniroute-oauth"].message, /OAuth plan usage stays in OmniRoute/);
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_ONLY_ENDPOINT_KEY/);
  } finally {
    delete process.env.OMNIROUTE_API_KEY;
  }
});

test("health probe distinguishes missing key, unauthorized, invalid, and healthy responses", async () => {
  assert.equal((await probeOmniroute()).state, "missing-key");

  let authorization;
  const healthy = await probeOmniroute({
    endpointKey: "TEST_ONLY_ENDPOINT_KEY",
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return new Response(JSON.stringify({ data: [{ id: "cc/claude-opus-4-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(authorization, "Bearer TEST_ONLY_ENDPOINT_KEY");
  assert.deepEqual(healthy, {
    ok: true,
    state: "healthy",
    detail: "1 direct model id(s) available for explicit curation",
    models: ["cc/claude-opus-4-1"],
  });

  const unauthorized = await probeOmniroute({
    endpointKey: "TEST_ONLY_ENDPOINT_KEY",
    fetchImpl: async () => new Response("secret body must not escape", { status: 401 }),
  });
  assert.equal(unauthorized.state, "unauthorized");
  assert.doesNotMatch(JSON.stringify(unauthorized), /secret body/);

  const invalid = await probeOmniroute({
    endpointKey: "TEST_ONLY_ENDPOINT_KEY",
    fetchImpl: async () => new Response("not json", { status: 200 }),
  });
  assert.equal(invalid.state, "invalid-response");
});

test("health probe refuses an unsafe endpoint before making a request", async () => {
  let called = false;
  const result = await probeOmniroute({
    baseUrl: "https://example.com/v1",
    endpointKey: "TEST_ONLY_ENDPOINT_KEY",
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(result.state, "unsafe-endpoint");
  assert.equal(called, false);
});
