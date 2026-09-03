import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { readZodexOmniroutePolicy, zodexConfigPath } from "./zodex-policy.mjs";
import { restartRouterServiceIfInstalled } from "./router-restart.mjs";

const SERVICE_NAME = "zodex-config-apply.service";
const PATH_NAME = "zodex-config-watch.path";
const STATE_FILE = path.join(STATE_DIR, "zodex-config-watch.json");
const DEBOUNCE_MS = 750;

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function configPaths(environment = process.env) {
  const file = zodexConfigPath(environment);
  if (!file) throw new Error("Cannot resolve the Zodex configuration path.");
  return { file, directory: path.dirname(file) };
}

function statePath(environment = process.env) {
  return path.resolve(environment.ZODEX_CONFIG_WATCH_STATE_FILE || STATE_FILE);
}

function rejectSymbolicLink(file, label) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return stat;
}

function readState(file) {
  try {
    const stat = requirePrivateFile(file);
    if (stat.size > 64 * 1024) throw new Error("state exceeds 64 KiB");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.lastAppliedRevision !== "string") throw new Error("state schema is invalid");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, lastAppliedRevision: "" };
    return { version: 1, lastAppliedRevision: "", lastStateError: "state reset" };
  }
}

function requirePrivateFile(file) {
  const stat = rejectSymbolicLink(file, "state file");
  if (!stat.isFile()) throw new Error("not a regular file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("wrong owner");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("unsafe permissions");
  return stat;
}

function writeState(file, state) {
  const directory = path.dirname(file);
  rejectSymbolicLink(directory, "state directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() ||
      (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (directoryStat.mode & 0o077) !== 0)) {
    throw new Error("Zodex config-watch state directory is unsafe");
  }
  rejectSymbolicLink(file, "state file");
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refreshManagedConfiguration({ spawn = spawnSync, environment = process.env } = {}) {
  const scripts = [
    "import('./src/litellm-config.mjs').then((m) => m.writeLiteLlmConfig())",
    "import('./src/catalog.mjs')",
  ];
  for (const script of scripts) {
    const result = spawn(process.execPath, ["-e", script], {
      cwd: SOURCE_ROOT,
      env: { ...environment, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      throw new Error("Managed Router configuration refresh failed.");
    }
  }
}

function triggerDeveloperUpdate(policy, { spawn = spawnSync, environment = process.env } = {}) {
  if (!policy.developerUpdates?.active) return { triggered: false };
  const executable = environment.ZODEX_UPDATE_MANAGER_BIN || "zodex-update-manager";
  const result = spawn(executable, ["check-now", "--developer-trigger"], {
    cwd: SOURCE_ROOT,
    env: environment,
    encoding: "utf8",
  });
  // A build/update failure is recorded by its own manager and must never roll
  // back a successfully applied routing configuration.
  return { triggered: true, ok: !result.error && result.status === 0 };
}

export async function applyZodexConfig({
  environment = process.env,
  spawn = spawnSync,
  restart = restartRouterServiceIfInstalled,
  wait = sleep,
} = {}) {
  await wait(DEBOUNCE_MS);
  const stateFile = statePath(environment);
  const state = readState(stateFile);
  const policy = readZodexOmniroutePolicy(environment);
  if (policy.state === "invalid") {
    writeState(stateFile, {
      ...state,
      lastInvalidRevision: policy.revision || `invalid-${digest(policy.error || "unknown")}`,
      lastError: "Zodex configuration is invalid; the last valid Router state remains active.",
    });
    return { applied: false, reason: "invalid", revision: policy.revision };
  }
  if (state.lastAppliedRevision === policy.revision) {
    return { applied: false, reason: "unchanged", revision: policy.revision };
  }
  refreshManagedConfiguration({ spawn, environment });
  const restarted = restart({ spawn, env: environment });
  const update = triggerDeveloperUpdate(policy, { spawn, environment });
  writeState(stateFile, {
    version: 1,
    lastAppliedRevision: policy.revision,
    lastAppliedAt: new Date().toISOString(),
    lastError: undefined,
    developerUpdateTriggered: update.triggered,
    developerUpdateOk: update.ok,
  });
  return { applied: true, revision: policy.revision, restarted, developerUpdate: update };
}

export function renderUnits(environment = process.env) {
  const { file, directory } = configPaths(environment);
  const node = environment.CODEX_ROUTER_NODE_BIN || process.execPath;
  if (!path.isAbsolute(node)) throw new Error("CODEX_ROUTER_NODE_BIN must be an absolute path.");
  const service = `[Unit]\nDescription=Apply validated Zodex configuration changes\n\n[Service]\nType=oneshot\nWorkingDirectory=${SOURCE_ROOT}\nExecStart=${systemdQuote(node)} ${systemdQuote(path.join(SOURCE_ROOT, "src", "zodex-config-watch.mjs"))} apply\n`;
  const watcher = `[Unit]\nDescription=Watch Zodex configuration changes\n\n[Path]\nPathChanged=${file}\nPathChanged=${directory}\nUnit=${SERVICE_NAME}\n\n[Install]\nWantedBy=default.target\n`;
  return { service, watcher };
}

export function installUnits(environment = process.env) {
  if (process.platform !== "linux") return { installed: false, reason: "unsupported-platform" };
  const root = environment.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const directory = path.join(root, "systemd", "user");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const units = renderUnits(environment);
  writeFileSync(path.join(directory, SERVICE_NAME), units.service, { encoding: "utf8", mode: 0o644 });
  writeFileSync(path.join(directory, PATH_NAME), units.watcher, { encoding: "utf8", mode: 0o644 });
  const result = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Could not reload the user systemd manager.");
  const enabled = spawnSync("systemctl", ["--user", "enable", "--now", PATH_NAME], { encoding: "utf8" });
  if (enabled.status !== 0) throw new Error("Could not enable the Zodex configuration watcher.");
  return { installed: true };
}

export function uninstallUnits(environment = process.env) {
  if (process.platform !== "linux") return { uninstalled: false, reason: "unsupported-platform" };
  const root = environment.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const directory = path.join(root, "systemd", "user");
  spawnSync("systemctl", ["--user", "disable", "--now", PATH_NAME], { encoding: "utf8" });
  for (const name of [SERVICE_NAME, PATH_NAME]) {
    const file = path.join(directory, name);
    if (existsSync(file)) unlinkSync(file);
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  return { uninstalled: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  try {
    if (command === "apply") process.stdout.write(`${JSON.stringify(await applyZodexConfig())}\n`);
    else if (command === "install") process.stdout.write(`${JSON.stringify(installUnits())}\n`);
    else if (command === "uninstall") process.stdout.write(`${JSON.stringify(uninstallUnits())}\n`);
    else if (command === "render") process.stdout.write(`${JSON.stringify(renderUnits())}\n`);
    else throw new Error("Usage: zodex-config-watch.mjs apply|install|uninstall|render");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
