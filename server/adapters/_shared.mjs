// Shared plumbing for the three real adapters.
// Keeps endpoint policy, timeouts and error sanitising in one place.
// No network access here: every adapter receives its fetch implementation.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class AdapterError extends Error {
  constructor(message, {
    code = "adapter_error",
    status = null,
    retryAfterSeconds = null,
    deliveryState = null,
  } = {}) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.status = Number.isInteger(status) ? status : null;
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? Math.ceil(retryAfterSeconds)
      : null;
    if (deliveryState !== null) this.deliveryState = deliveryState;
  }
}

export function configError(field) {
  return new AdapterError(`invalid adapter configuration: ${field}`, { code: "invalid_config" });
}

export function requireSecret(value, field) {
  if (typeof value !== "string") throw configError(field);
  const token = value.trim();
  // Credentials travel in headers or a single URL path segment; never allow
  // whitespace or control characters that could split a header or a path.
  if (token === "" || /[\u0000-\u0020\u007f]/u.test(token)) throw configError(field);
  return token;
}

export function requireNonEmptyString(value, field, maxLength = 4096) {
  if (typeof value !== "string") throw configError(field);
  const text = value.trim();
  if (text === "" || text.length > maxLength) throw configError(field);
  return text;
}

export function parseTimeout(value, fallback = 15000, max = 120000) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw configError("timeoutMs");
  return value;
}

export function parsePositiveInt(value, field, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw configError(field);
  return value;
}

export function isLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function assertBaseUrl(value, { field = "baseUrl", fallback } = {}) {
  const raw = value === undefined ? fallback : value;
  if (typeof raw !== "string" || raw.trim() === "") throw configError(field);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw configError(field);
  }
  if (url.username !== "" || url.password !== "") throw configError(field);
  if (url.search !== "" || url.hash !== "") throw configError(field);

  // Plain HTTP is only safe on loopback; anything else must be TLS.
  const https = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!https && !loopback) throw configError(field);

  return url.href.replace(/\/+$/u, "");
}

export function requireId(value, field) {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== "string" || text.trim() === "") {
    throw new AdapterError("invalid input", { code: "invalid_input" });
  }
  const id = text.trim();
  if (/[\u0000-\u0020\u007f]/u.test(id)) {
    throw new AdapterError("invalid input", { code: "invalid_input" });
  }
  return id;
}

function transportError(err, failureMessage, deliveryState) {
  const name = err?.name;
  const code = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
  // Deliberately no cause: fetch errors may carry the request URL or host.
  return new AdapterError(failureMessage, { code, deliveryState });
}

function parseSeconds(raw, nowSeconds) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number" || /^\d+(?:\.\d+)?$/u.test(String(raw).trim())) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
  }
  const when = Date.parse(String(raw));
  if (!Number.isFinite(when)) return null;
  return Math.max(0, Math.ceil(when / 1000 - nowSeconds));
}

export function retryAfterFrom(headers, data) {
  const get = typeof headers?.get === "function" ? headers.get.bind(headers) : () => null;
  const nowSeconds = Date.now() / 1000;

  const retryAfter = parseSeconds(get("retry-after"), nowSeconds);
  if (retryAfter !== null) return retryAfter;

  const reset = get("x-rate-limit-reset");
  if (reset !== null && /^\d+$/u.test(String(reset).trim())) {
    const delta = Number(reset) - nowSeconds;
    if (Number.isFinite(delta)) return Math.max(0, Math.ceil(delta));
  }

  return parseSeconds(data?.parameters?.retry_after ?? data?.retry_after, nowSeconds);
}

async function readLimitedText(body) {
  const reader=body.getReader();
  const limit=2*1024*1024;
  const chunks=[];
  let total=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) return Buffer.concat(chunks,total).toString('utf8');
      total+=value.byteLength;
      if (total>limit) { void reader.cancel().catch(()=>{}); throw new Error('Response size limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
}

// One request, no redirects, bounded time, JSON body parsed or null.
// Non-2xx responses become AdapterError with only status / retry metadata.
export async function requestJson(fetchImpl, url, {
  method = "GET",
  headers = {},
  body,
  timeoutMs,
  failureMessage,
  deliveryState = null,
} = {}) {
  const controller = new AbortController();
  const timeoutError = new DOMException("request timed out", "TimeoutError");
  let timer;
  // The race guarantees a deadline even if an injected fetch ignores the
  // AbortSignal. The fetch is still aborted so it can release resources.
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  timer.unref?.();

  let response;
  try {
    response = await Promise.race([
      fetchImpl(url, {
        method,
        headers,
        body,
        redirect: "error",
        signal: controller.signal,
      }),
      deadline,
    ]);
  } catch (err) {
    clearTimeout(timer);
    throw transportError(err, failureMessage, deliveryState);
  }

  const status = Number.isInteger(response?.status) ? response.status : null;
  let data = null;
  let text = "";

  if (typeof response?.text === "function") {
    try {
      const stream=response.body;
      text = await Promise.race([typeof stream?.getReader==='function' ? readLimitedText(stream) : response.text(), deadline]);
    } catch (err) {
      clearTimeout(timer);
      throw transportError(err, failureMessage, deliveryState);
    }
  } else if (typeof response?.json === "function") {
    try {
      data = await Promise.race([response.json(), deadline]);
    } catch (err) {
      const name = err?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        clearTimeout(timer);
        throw transportError(err, failureMessage, deliveryState);
      }
      data = null;
    }
  }
  clearTimeout(timer);

  if (data === null && text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  const ok = typeof response?.ok === "boolean"
    ? response.ok
    : status === null || (status >= 200 && status < 300);

  if (!ok) {
    throw new AdapterError(failureMessage, {
      code: "http_error",
      status,
      retryAfterSeconds: retryAfterFrom(response?.headers, data),
      deliveryState,
    });
  }
  if (data === null) {
    throw new AdapterError(failureMessage, { code: "invalid_response", status, deliveryState });
  }

  return { data, status, headers: response?.headers };
}
