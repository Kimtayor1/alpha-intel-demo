// Telegram Bot API adapter: JSON only, plain text, no parse_mode.
// Docs: POST /bot<token>/sendMessage -> {ok, result:{message_id}}.
import {
  AdapterError,
  assertBaseUrl,
  configError,
  parseTimeout,
  requestJson,
  retryAfterFrom,
} from "./_shared.mjs";

const FAILURE = "telegram send failed";
const STATES = new Set(["retryable", "rejected", "uncertain"]);

function deliveryError(state, { status = null, retryAfterSeconds = null, code } = {}) {
  if (!STATES.has(state)) throw configError("deliveryState");
  return new AdapterError(FAILURE, {
    code: code ?? (state === "retryable"
      ? "rate_limited"
      : state === "rejected"
        ? "rejected"
        : "uncertain_delivery"),
    status,
    retryAfterSeconds,
    deliveryState: state,
  });
}

function toDeliveryError(err) {
  if (!(err instanceof AdapterError)) return err;

  if (err.code === "timeout" || err.code === "network") {
    return deliveryError("uncertain", {
      status: err.status,
      retryAfterSeconds: err.retryAfterSeconds,
      code: err.code,
    });
  }
  if (err.code === "invalid_response") {
    return deliveryError("uncertain", {
      status: err.status,
      retryAfterSeconds: err.retryAfterSeconds,
      code: "uncertain_delivery",
    });
  }
  if (err.code === "http_error") {
    if (err.status === 429) {
      return deliveryError("retryable", {
        status: err.status,
        retryAfterSeconds: err.retryAfterSeconds,
        code: "rate_limited",
      });
    }
    if (err.status !== null && err.status >= 400 && err.status < 500) {
      return deliveryError("rejected", {
        status: err.status,
        retryAfterSeconds: err.retryAfterSeconds,
        code: "rejected",
      });
    }
    return deliveryError("uncertain", {
      status: err.status,
      retryAfterSeconds: err.retryAfterSeconds,
      code: "uncertain_delivery",
    });
  }

  return err;
}

function normalizeBotToken(value) {
  if (typeof value !== "string") throw configError("botToken");
  const token = value.trim();
  // Telegram tokens are "digits:base64-ish". Reject slashes/at signs so the
  // token can never escape its single path segment.
  if (token === "" || !/^[A-Za-z0-9:_-]+$/u.test(token)) throw configError("botToken");
  return token;
}

function normalizeChatId(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw configError("chatId");
    return value;
  }
  if (typeof value !== "string") throw configError("chatId");
  const chatId = value.trim();
  if (chatId === "" || chatId.length > 128 || /[\u0000-\u001f\u007f]/u.test(chatId)) {
    throw configError("chatId");
  }
  return chatId;
}

function messageId(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function createTelegramAdapter(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw configError("config");
  if (typeof fetchImpl !== "function") throw configError("fetchImpl");

  const botToken = normalizeBotToken(config.botToken);
  const chatId = normalizeChatId(config.chatId);
  const baseUrl = assertBaseUrl(config.baseUrl, {
    field: "baseUrl",
    fallback: "https://api.telegram.org",
  });
  const timeoutMs = parseTimeout(config.timeoutMs);
  const headers = { "content-type": "application/json", accept: "application/json" };
  const endpoint = `${baseUrl}/bot${botToken}/sendMessage`;

  async function send(text) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new AdapterError("invalid input", {
        code: "invalid_input",
        deliveryState: "rejected",
      });
    }

    let result;
    try {
      result = await requestJson(fetchImpl, endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ chat_id: chatId, text }),
        timeoutMs,
        failureMessage: FAILURE,
      });
    } catch (err) {
      throw toDeliveryError(err);
    }

    const data = result.data;

    if (data?.ok !== true) {
      const errorCode = Number.isInteger(data?.error_code) ? data.error_code : result.status;
      const retryAfterSeconds = retryAfterFrom(result.headers, data);
      if (errorCode === 429) {
        throw deliveryError("retryable", {
          status: errorCode,
          retryAfterSeconds,
          code: "rate_limited",
        });
      }
      if (errorCode !== null && errorCode >= 400 && errorCode < 500) {
        throw deliveryError("rejected", {
          status: errorCode,
          retryAfterSeconds,
          code: "rejected",
        });
      }
      throw deliveryError("uncertain", {
        status: errorCode,
        retryAfterSeconds,
        code: "uncertain_delivery",
      });
    }

    const id = messageId(data?.result?.message_id);
    if (id === null) {
      // The request may have been delivered; never report success and never
      // silently retry from here.
      throw deliveryError("uncertain", { status: result.status });
    }
    return { messageId: id };
  }

  return { send };
}
