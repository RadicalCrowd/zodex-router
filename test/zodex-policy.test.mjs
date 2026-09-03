import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyZodexProviderPolicy,
  parseZodexOmniroutePolicy,
  readZodexOmniroutePolicy,
  zodexConfigRevision,
  zodexOmnirouteModelEnabled,
} from "../src/zodex-policy.mjs";

const acknowledgements = ["zodex-oauth-risk-v1", "zodex-oauth-effects-v1"];

function config({ broker = true, anthropic = acknowledgements, google = [] } = {}) {
  return {
    version: 1,
    oauth: {
      brokers: {
        omniroute: {
          enabled: broker,
          providers: {
            anthropic: { enabled: true, acknowledgements: [...anthropic] },
            google: { enabled: true, acknowledgements: [...google] },
          },
        },
      },
    },
    remoteControl: { enabled: false, extensions: [] },
  };
}

test("OmniRoute requires both acknowledgements for each upstream provider", () => {
  assert.deepEqual(parseZodexOmniroutePolicy(config()).activeProviders, ["anthropic"]);
  assert.deepEqual(
    parseZodexOmniroutePolicy(config({ anthropic: [acknowledgements[0]] })).activeProviders,
    [],
  );
  assert.deepEqual(parseZodexOmniroutePolicy(config({ broker: false })).activeProviders, []);
});

test("provider selection cannot activate OmniRoute without the Zodex file gate", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zodex-router-policy-"));
  const file = path.join(root, "config.json");
  try {
    const environment = { ZODEX_CONFIG_FILE: file };
    assert.deepEqual(
      applyZodexProviderPolicy(["kilo-free", "opencode-free", "omniroute-oauth"], environment),
      ["kilo-free", "opencode-free"],
    );
    writeFileSync(file, `${JSON.stringify(config())}\n`, { mode: 0o600 });
    assert.deepEqual(
      applyZodexProviderPolicy(["kilo-free", "opencode-free"], environment),
      ["kilo-free", "opencode-free", "omniroute-oauth"],
    );
    assert.deepEqual(readZodexOmniroutePolicy(environment).activeProviders, ["anthropic"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model gate maps acknowledged providers to direct OmniRoute prefixes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zodex-router-model-policy-"));
  const file = path.join(root, "config.json");
  try {
    writeFileSync(file, `${JSON.stringify(config())}\n`, { mode: 0o600 });
    const environment = { ZODEX_CONFIG_FILE: file };
    assert.equal(zodexOmnirouteModelEnabled("cc/claude-opus-4-1", environment), true);
    assert.equal(zodexOmnirouteModelEnabled("anthropic/claude-opus-4-1", environment), true);
    assert.equal(zodexOmnirouteModelEnabled("gemini/gemini-2.5-pro", environment), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy rejects secret-like JSON fields and fails closed", () => {
  const value = config();
  value.oauth.brokers.omniroute.apiKey = "must-not-be-here";
  assert.throws(() => parseZodexOmniroutePolicy(value), /credentials never belong in Zodex JSON/);

  const unknown = config();
  unknown.oauth.brokers.omniroute.providers.unreviewed = {
    enabled: true,
    acknowledgements,
  };
  assert.throws(() => parseZodexOmniroutePolicy(unknown), /is not audited/);

  const unknownTopLevel = config();
  unknownTopLevel.oauth.magic = true;
  assert.throws(() => parseZodexOmniroutePolicy(unknownTopLevel), /unknown key 'magic'/);

  const unknownAcknowledgement = config();
  unknownAcknowledgement.oauth.brokers.omniroute.providers.anthropic.acknowledgements.push(
    "accept-everything-forever",
  );
  assert.throws(
    () => parseZodexOmniroutePolicy(unknownAcknowledgement),
    /unknown acknowledgement/,
  );
});

test("policy reader refuses group-readable configuration", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zodex-router-mode-policy-"));
  const file = path.join(root, "config.json");
  try {
    writeFileSync(file, `${JSON.stringify(config())}\n`, { mode: 0o644 });
    const policy = readZodexOmniroutePolicy({ ZODEX_CONFIG_FILE: file });
    assert.equal(policy.state, "invalid");
    assert.deepEqual(policy.activeProviders, []);
    assert.match(policy.error, /permissions must be 0600/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("developer update acknowledgements are default-off and part of the semantic revision", () => {
  const base = config();
  const parsed = parseZodexOmniroutePolicy(base);
  assert.equal(parsed.developerUpdates.active, false);
  const enabled = config();
  enabled.developerUpdates = {
    enabled: true,
    acknowledgements: ["zodex-developer-update-source-v1", "zodex-developer-update-install-v1"],
  };
  const updatePolicy = parseZodexOmniroutePolicy(enabled);
  assert.equal(updatePolicy.developerUpdates.active, true);
  assert.notEqual(zodexConfigRevision(parsed), zodexConfigRevision(updatePolicy));
});
