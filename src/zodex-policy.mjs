import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ACKNOWLEDGEMENT_RISK = "zodex-oauth-risk-v1";
const ACKNOWLEDGEMENT_EFFECTS = "zodex-oauth-effects-v1";
const OMNIROUTE_PROVIDER_ID = "omniroute-oauth";
const SECRET_KEY_PATTERN = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential|private[-_]?key)/iu;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const BROKER_PROVIDERS = Object.freeze({
  omniroute: new Set(["anthropic", "google"]),
  "opencode-community": new Set(),
});

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${location} contains unknown key '${key}'`);
  }
}

function rejectSecrets(value, location = "config") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`${location}.${key} is forbidden; credentials never belong in Zodex JSON`);
    }
    rejectSecrets(entry, `${location}.${key}`);
  }
}

export function zodexConfigPath(environment = process.env) {
  if (typeof environment.ZODEX_CONFIG_FILE === "string" && environment.ZODEX_CONFIG_FILE.trim()) {
    return path.resolve(environment.ZODEX_CONFIG_FILE);
  }
  const root = environment.XDG_CONFIG_HOME ||
    (environment.HOME ? path.join(environment.HOME, ".config") : undefined);
  return root ? path.join(root, "zodex", "config.json") : undefined;
}

function parseConnection(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be an object`);
  assertKnownKeys(value, ["enabled", "acknowledgements"], location);
  if (typeof value.enabled !== "boolean") throw new Error(`${location}.enabled must be a boolean`);
  if (!Array.isArray(value.acknowledgements) || value.acknowledgements.some((item) => typeof item !== "string")) {
    throw new Error(`${location}.acknowledgements must be an array of strings`);
  }
  const acknowledgements = [...new Set(value.acknowledgements)];
  const allowed = [ACKNOWLEDGEMENT_RISK, ACKNOWLEDGEMENT_EFFECTS];
  const unknown = acknowledgements.filter((item) => !allowed.includes(item));
  if (unknown.length) throw new Error(`${location} has unknown acknowledgement '${unknown[0]}'`);
  return {
    enabled: value.enabled,
    active: value.enabled &&
      acknowledgements.includes(ACKNOWLEDGEMENT_RISK) &&
      acknowledgements.includes(ACKNOWLEDGEMENT_EFFECTS),
  };
}

export function parseZodexOmniroutePolicy(value) {
  if (!isObject(value)) throw new Error("config must be an object");
  rejectSecrets(value);
  assertKnownKeys(value, ["version", "oauth", "remoteControl"], "config");
  if (value.version !== 1) throw new Error("config.version must be 1");
  if (!isObject(value.oauth)) throw new Error("config.oauth must be an object");
  assertKnownKeys(value.oauth, ["brokers"], "config.oauth");
  const brokers = value.oauth.brokers;
  if (!isObject(brokers)) throw new Error("config.oauth.brokers must be an object");
  const parsedBrokers = {};
  for (const [brokerId, brokerValue] of Object.entries(brokers)) {
    if (!Object.hasOwn(BROKER_PROVIDERS, brokerId)) {
      throw new Error(`config.oauth.brokers.${brokerId} is not an audited broker`);
    }
    const location = `config.oauth.brokers.${brokerId}`;
    if (!isObject(brokerValue)) throw new Error(`${location} must be an object`);
    assertKnownKeys(brokerValue, ["enabled", "providers"], location);
    if (typeof brokerValue.enabled !== "boolean") throw new Error(`${location}.enabled must be a boolean`);
    if (!isObject(brokerValue.providers)) throw new Error(`${location}.providers must be an object`);
    const providers = {};
    for (const [providerId, connection] of Object.entries(brokerValue.providers)) {
      if (!ID_PATTERN.test(providerId) || !BROKER_PROVIDERS[brokerId].has(providerId)) {
        throw new Error(`${location}.providers.${providerId} is not audited`);
      }
      providers[providerId] = parseConnection(connection, `${location}.providers.${providerId}`);
    }
    parsedBrokers[brokerId] = { enabled: brokerValue.enabled, providers };
  }
  if (!isObject(value.remoteControl)) throw new Error("config.remoteControl must be an object");
  assertKnownKeys(value.remoteControl, ["enabled", "extensions"], "config.remoteControl");
  if (typeof value.remoteControl.enabled !== "boolean") {
    throw new Error("config.remoteControl.enabled must be a boolean");
  }
  if (!Array.isArray(value.remoteControl.extensions) ||
      value.remoteControl.extensions.some((id) => !ID_PATTERN.test(id))) {
    throw new Error("config.remoteControl.extensions must be an array of module ids");
  }
  const broker = parsedBrokers.omniroute;
  const activeProviders = broker?.enabled
    ? Object.entries(broker.providers)
    .filter(([, connection]) => connection.active)
    .map(([id]) => id)
    .sort()
    : [];
  return { activeProviders };
}

export function readZodexOmniroutePolicy(environment = process.env) {
  const file = zodexConfigPath(environment);
  if (!file || !existsSync(file)) return { state: "missing", file, activeProviders: [] };
  try {
    let text;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = statSync(file);
      if (!before.isFile()) throw new Error("config path is not a regular file");
      if (before.size > 64 * 1024) throw new Error("config file exceeds 64 KiB");
      if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
        throw new Error("config file is not owned by the current user");
      }
      if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
        throw new Error("config file permissions must be 0600");
      }
      text = readFileSync(file, "utf8");
      const after = statSync(file);
      if (
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs
      ) break;
      text = undefined;
    }
    if (text === undefined) throw new Error("config changed while it was being read; refresh again");
    return { state: "valid", file, ...parseZodexOmniroutePolicy(JSON.parse(text)) };
  } catch (error) {
    return {
      state: "invalid",
      file,
      activeProviders: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyZodexProviderPolicy(providerIds, environment = process.env) {
  const ids = providerIds.filter((id) => id !== OMNIROUTE_PROVIDER_ID);
  const policy = readZodexOmniroutePolicy(environment);
  if (policy.activeProviders.length > 0) ids.push(OMNIROUTE_PROVIDER_ID);
  return [...new Set(ids)];
}

function modelPrefixes(providerId) {
  if (providerId === "anthropic") return ["cc/", "anthropic/"];
  if (providerId === "google") return ["gemini/", "google/"];
  return [`${providerId}/`];
}

export function zodexOmnirouteModelEnabled(modelId, environment = process.env) {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (!id) return false;
  const policy = readZodexOmniroutePolicy(environment);
  return policy.activeProviders.some((providerId) =>
    modelPrefixes(providerId).some((prefix) => id.startsWith(prefix))
  );
}

export const ZODEX_ACKNOWLEDGEMENTS = Object.freeze([
  ACKNOWLEDGEMENT_RISK,
  ACKNOWLEDGEMENT_EFFECTS,
]);
