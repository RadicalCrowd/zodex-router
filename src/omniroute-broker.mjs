const DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";
const REQUEST_TIMEOUT_MS = 2_500;

function normalizedBaseUrl(value) {
  return String(value || "").replace(/\/+$/u, "");
}

export function omnirouteLoopbackProblem(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return "OmniRoute must use plain HTTP on loopback";
    if (url.hostname !== "127.0.0.1") return "OmniRoute must bind to 127.0.0.1";
    if (url.port !== "20128") return "OmniRoute must use the pinned local port 20128";
    if (url.pathname.replace(/\/+$/u, "") !== "/v1") return "OmniRoute base URL must end in /v1";
    return undefined;
  } catch {
    return "OmniRoute base URL is invalid";
  }
}

export function isDirectOmnirouteModelId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) return false;
  const lower = id.toLowerCase();
  return !lower.includes("auto") && !lower.includes("combo") && !lower.includes("fallback");
}

export function directOmnirouteModelIds(payload) {
  if (!Array.isArray(payload?.data)) return [];
  return [...new Set(payload.data.map((entry) => entry?.id).filter(isDirectOmnirouteModelId))].sort();
}

export async function probeOmniroute({
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
  endpointKey,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const problem = omnirouteLoopbackProblem(baseUrl);
  if (problem) return { ok: false, state: "unsafe-endpoint", detail: problem };
  if (typeof endpointKey !== "string" || !endpointKey.trim()) {
    return { ok: false, state: "missing-key", detail: "OmniRoute endpoint key is not configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${normalizedBaseUrl(baseUrl)}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${endpointKey.trim()}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, state: "unauthorized", detail: "OmniRoute rejected the endpoint key" };
    }
    if (!response.ok) {
      return { ok: false, state: "unhealthy", detail: `OmniRoute /models returned HTTP ${response.status}` };
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, state: "invalid-response", detail: "OmniRoute /models did not return JSON" };
    }
    const models = directOmnirouteModelIds(payload);
    return {
      ok: true,
      state: "healthy",
      detail: `${models.length} direct model id(s) available for explicit curation`,
      models,
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return {
      ok: false,
      state: timedOut ? "timeout" : "unreachable",
      detail: timedOut ? "OmniRoute health probe timed out" : "OmniRoute is not reachable on 127.0.0.1:20128",
    };
  } finally {
    clearTimeout(timer);
  }
}

export const OMNIROUTE_BASE_URL = DEFAULT_BASE_URL;
