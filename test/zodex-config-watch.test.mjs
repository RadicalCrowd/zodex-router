import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyZodexConfig, renderUnits } from "../src/zodex-config-watch.mjs";

function configuration() {
  return {
    version: 1,
    oauth: { brokers: { omniroute: { enabled: false, providers: {} } } },
    remoteControl: { enabled: false, extensions: [] },
  };
}

test("config apply debounces, refreshes once, and skips semantic no-ops", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zodex-config-watch-"));
  const config = path.join(root, "config.json");
  const state = path.join(root, "state.json");
  const environment = { ZODEX_CONFIG_FILE: config, ZODEX_CONFIG_WATCH_STATE_FILE: state };
  const calls = [];
  let restarts = 0;
  const spawn = (_command, args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    writeFileSync(config, `${JSON.stringify(configuration())}\n`, { mode: 0o600 });
    const first = await applyZodexConfig({ environment, spawn, restart: () => { restarts += 1; return true; }, wait: async () => {} });
    assert.equal(first.applied, true);
    assert.equal(calls.length, 2);
    writeFileSync(config, `${JSON.stringify(configuration(), null, 2)}\n`, { mode: 0o600 });
    const second = await applyZodexConfig({ environment, spawn, restart: () => { restarts += 1; return true; }, wait: async () => {} });
    assert.equal(second.reason, "unchanged");
    assert.equal(calls.length, 2);
    assert.equal(restarts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid config retains the previously applied Router state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zodex-config-watch-invalid-"));
  const config = path.join(root, "config.json");
  const state = path.join(root, "state.json");
  const environment = { ZODEX_CONFIG_FILE: config, ZODEX_CONFIG_WATCH_STATE_FILE: state };
  try {
    const calls = [];
    const spawn = (_command, args) => { calls.push(args); return { status: 0 }; };
    writeFileSync(config, `${JSON.stringify(configuration())}\n`, { mode: 0o600 });
    await applyZodexConfig({ environment, spawn, restart: () => true, wait: async () => {} });
    writeFileSync(config, "{ invalid", { mode: 0o600 });
    const result = await applyZodexConfig({ environment, spawn, restart: () => true, wait: async () => {} });
    assert.deepEqual(result.applied, false);
    assert.equal(result.reason, "invalid");
    assert.equal(calls.length, 2);
    writeFileSync(config, `${JSON.stringify({ ...configuration(), remoteControl: { enabled: true, extensions: [] } })}\n`, { mode: 0o600 });
    const recovered = await applyZodexConfig({ environment, spawn, restart: () => true, wait: async () => {} });
    assert.equal(recovered.applied, true);
    assert.equal(calls.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic config replacement is accepted and unsafe permissions are retained", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zodex-config-watch-atomic-"));
  const config = path.join(root, "config.json");
  const replacement = path.join(root, "config.json.new");
  const state = path.join(root, "state.json");
  const environment = { ZODEX_CONFIG_FILE: config, ZODEX_CONFIG_WATCH_STATE_FILE: state };
  const spawn = () => ({ status: 0, stdout: "", stderr: "" });
  try {
    writeFileSync(replacement, `${JSON.stringify(configuration())}\n`, { mode: 0o600 });
    renameSync(replacement, config);
    const first = await applyZodexConfig({ environment, spawn, restart: () => false, wait: async () => {} });
    assert.equal(first.applied, true);
    chmodSync(config, 0o644);
    const unsafe = await applyZodexConfig({ environment, spawn, restart: () => false, wait: async () => {} });
    assert.equal(unsafe.reason, "invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rendered systemd units watch both the config file and its directory", () => {
  const units = renderUnits({ ZODEX_CONFIG_FILE: "/tmp/zodex/config.json", CODEX_ROUTER_NODE_BIN: process.execPath });
  assert.match(units.watcher, /PathChanged=\/tmp\/zodex\/config\.json/);
  assert.match(units.watcher, /PathChanged=\/tmp\/zodex/);
  assert.match(units.service, /zodex-config-watch\.mjs/);
});
