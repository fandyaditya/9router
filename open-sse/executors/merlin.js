import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { refreshProviderCredentials } from "../services/oauthCredentialManager.js";

const MERLIN_CHAT_API = PROVIDERS.merlin.baseUrl;
const MERLIN_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const MERLIN_DEFAULT_MODEL = "merlin-magic";
const MERLIN_NO_TOOL_INSTRUCTION = [
  "9Router adapter note: Merlin built-in tools and modes are unavailable, including Search, web access, browser, document, image, code, and any Merlin app-side tool.",
  "Do not attempt to use or mention Merlin built-in tools, and never ask the user to enable a Merlin tool, mode, toggle, or icon.",
  "If client tool results are present in the conversation, answer from those results. Otherwise answer directly from the provided context and model knowledge.",
].join(" ");

const MERLIN_INTERNAL_TOOL_ARTIFACT_PATTERNS = [
  /I tried [\s\S]{0,300} as a necessary step in response generation,\s*but [\s\S]{0,80} (?:is|are) (?:off|disabled|unavailable)\.[\s\S]*?(?:Once you[’']re done,\s*you can retry this prompt\.|retry this prompt\.)/gi,
  /To get [\s\S]{0,300},\s*I[’']?d need you to turn [\s\S]{0,80} on\.[\s\S]*?(?:Once you[’']re done,\s*you can retry this prompt\.|retry this prompt\.)/gi,
  /(?:Please|You need to|I need you to) (?:enable|turn on) [\s\S]{0,80}(?:tool|mode|access|search|browser|image|document|code)[\s\S]*?(?:retry this prompt|try again|continue)\.?/gi,
];

function fetchMerlin(url, options, proxyOptions = null) {
  const hasProxy =
    proxyOptions?.connectionProxyEnabled === true ||
    !!proxyOptions?.vercelRelayUrl;
  return hasProxy ? proxyAwareFetch(url, options, proxyOptions) : fetch(url, options);
}

function normalizeTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      if (part?.text) return part.text;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

export function parseOpenAIMessages(messages = []) {
  const history = [];
  let system = "";

  for (const msg of messages) {
    let role = String(msg?.role || "user");
    if (role === "developer") role = "system";

    const content = normalizeTextContent(msg?.content).trim();
    if (!content) continue;

    if (role === "system") {
      system += `${content}\n`;
    } else if (role === "assistant" || role === "user" || role === "tool") {
      history.push({ role, content });
    }
  }

  let current = "";
  if (history.length > 0 && history[history.length - 1].role === "user") {
    current = history.pop().content;
  } else if (history.length > 0) {
    current = history.map((msg) => `${msg.role}: ${msg.content}`).join("\n");
    history.length = 0;
  }

  return { system: system.trim(), history, current };
}

function buildContext(parsed) {
  const context = [MERLIN_NO_TOOL_INSTRUCTION];
  if (parsed.system) context.push(`system: ${parsed.system}`);
  for (const msg of parsed.history) context.push(`${msg.role}: ${msg.content}`);

  return context.join("\n");
}

export function sanitizeMerlinContent(content) {
  const text = String(content || "");
  if (!text) return "";

  let sanitized = text;
  for (const pattern of MERLIN_INTERNAL_TOOL_ARTIFACT_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }

  sanitized = sanitized
    .replace(/\n\s*!Instructions\s*\n/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (/^[\s,.;:!-]*(?:then\s*)?(?:try again|retry this prompt|continue)?[\s.]*$/i.test(sanitized)) {
    return "";
  }

  const lower = sanitized.toLowerCase();
  if (
    (
      lower.includes("retry this prompt") ||
      lower.includes("click") ||
      lower.includes("turn") ||
      lower.includes("enable")
    ) &&
    (
      lower.includes(" is off") ||
      lower.includes(" are off") ||
      lower.includes("disabled") ||
      lower.includes("unavailable")
    ) &&
    (
      lower.includes("tool") ||
      lower.includes("search") ||
      lower.includes("web access") ||
      lower.includes("browser") ||
      lower.includes("document") ||
      lower.includes("image") ||
      lower.includes("code") ||
      lower.includes("globe")
    )
  ) {
    return "";
  }

  return sanitized;
}

export function buildMerlinRequest(model, body) {
  const parsed = parseOpenAIMessages(body?.messages || []);
  const content = parsed.current || body?.prompt || "";

  return {
    attachments: [],
    chatId: crypto.randomUUID(),
    language: "AUTO",
    message: {
      content,
      context: buildContext(parsed),
      childId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      parentId: "root",
    },
    mode: "UNIFIED_CHAT",
    model: model || MERLIN_DEFAULT_MODEL,
    metadata: {
      largeContext: false,
      merlinMagic: model === "merlin-magic",
      proFinderMode: false,
      webAccess: false,
    },
  };
}

export function normalizeMerlinToken(rawToken) {
  const parsed = parseMerlinSessionData(rawToken);
  return parsed.accessToken || "";
}

function parseJsonObject(value) {
  if (!value || typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function cleanToken(token) {
  let value = String(token || "").trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (value.toLowerCase().startsWith("bearer ")) value = value.slice(7).trim();
  if (value.startsWith("MERLIN_SESSION_TOKEN=")) value = value.slice("MERLIN_SESSION_TOKEN=".length).trim();
  return value;
}

function extractFirebaseApiKey(...sources) {
  const explicit = firstPresent(
    ...sources.flatMap((source) => source && typeof source === "object"
      ? [
          source.firebaseApiKey,
          source.firebase_api_key,
          source.apiKey,
          source.api_key,
          source.config?.apiKey,
          source.firebaseConfig?.apiKey,
          source.providerSpecificData?.firebaseApiKey,
        ]
      : [])
  );
  if (explicit) return explicit;

  const storageKey = firstPresent(
    ...sources.flatMap((source) => source && typeof source === "object"
      ? [source.fbase_key, source.firebaseKey, source.key]
      : [])
  );
  if (typeof storageKey === "string") {
    const match = storageKey.match(/firebase:authUser:([^:]+):/);
    if (match?.[1]) return match[1];
  }

  return null;
}

function normalizeParsedMerlinSession(parsed, fallbackToken = "") {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { accessToken: cleanToken(fallbackToken) };
  }

  const value = parseJsonObject(parsed.value);
  const user = parseJsonObject(parsed.user);
  const stsTokenManager = parseJsonObject(
    parsed.stsTokenManager ||
    value?.stsTokenManager ||
    user?.stsTokenManager
  );

  const token = cleanToken(firstPresent(
    parsed.idToken,
    parsed.id_token,
    parsed.accessToken,
    parsed.access_token,
    parsed.sessionToken,
    parsed.session_token,
    parsed.token,
    user?.idToken,
    user?.id_token,
    user?.accessToken,
    user?.access_token,
    user?.sessionToken,
    user?.session_token,
    value?.idToken,
    value?.id_token,
    value?.accessToken,
    value?.access_token,
    value?.sessionToken,
    value?.session_token,
    stsTokenManager?.accessToken,
    stsTokenManager?.idToken,
    stsTokenManager?.id_token,
    fallbackToken
  ));

  const expiresIn = Number(firstPresent(
    parsed.expiresIn,
    parsed.expires_in,
    user?.expiresIn,
    user?.expires_in,
    value?.expiresIn,
    value?.expires_in,
    stsTokenManager?.expiresIn,
    stsTokenManager?.expires_in
  ));

  const firebaseApiKey = extractFirebaseApiKey(parsed, user, value, stsTokenManager);

  return {
    accessToken: token,
    idToken: firstPresent(
      parsed.idToken,
      parsed.id_token,
      user?.idToken,
      user?.id_token,
      user?.accessToken,
      user?.access_token,
      value?.idToken,
      value?.id_token,
      value?.accessToken,
      value?.access_token,
      stsTokenManager?.accessToken,
      stsTokenManager?.idToken,
      stsTokenManager?.id_token,
      token
    ),
    refreshToken: firstPresent(
      parsed.refreshToken,
      parsed.refresh_token,
      user?.refreshToken,
      user?.refresh_token,
      value?.refreshToken,
      value?.refresh_token,
      stsTokenManager?.refreshToken,
      stsTokenManager?.refresh_token
    ),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
    expiresAt: firstPresent(
      parsed.expiresAt,
      parsed.expires_at,
      user?.expiresAt,
      user?.expires_at,
      value?.expiresAt,
      value?.expires_at,
      stsTokenManager?.expirationTime,
      stsTokenManager?.expiresAt,
      stsTokenManager?.expires_at,
      parsed.expires
    ),
    email: firstPresent(parsed.email, user?.email, value?.email, parsed.userInfo?.email),
    localId: firstPresent(
      parsed.localId,
      parsed.local_id,
      parsed.user_id,
      user?.uid,
      user?.id,
      user?.localId,
      value?.uid,
      value?.id,
      value?.localId
    ),
    projectId: firstPresent(
      parsed.projectId,
      parsed.project_id,
      user?.projectId,
      user?.project_id,
      value?.projectId,
      value?.project_id
    ),
    firebaseApiKey,
    planName: firstPresent(parsed.planName, user?.planName, value?.planName),
    userPlan: firstPresent(parsed.userPlan, user?.userPlan, value?.userPlan),
    role: firstPresent(parsed.role, user?.role, value?.role),
    aggregator: firstPresent(parsed.aggregator, user?.aggregator, value?.aggregator),
  };
}

export function parseMerlinSessionData(rawToken) {
  if (rawToken && typeof rawToken === "object" && !Array.isArray(rawToken)) {
    return normalizeParsedMerlinSession(rawToken);
  }

  let token = String(rawToken || "").trim();
  let parsed = null;
  if (!token) return {};

  if ((token.startsWith("{") && token.endsWith("}")) || (token.startsWith("[") && token.endsWith("]"))) {
    try {
      parsed = JSON.parse(token);
    } catch {
      // Fall through and treat the input as a raw token.
    }
  }

  return parsed
    ? normalizeParsedMerlinSession(parsed)
    : normalizeParsedMerlinSession(null, token);
}

export function buildMerlinHeaders(token) {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${normalizeMerlinToken(token)}`,
    Origin: "https://www.getmerlin.in",
    Referer: "https://www.getmerlin.in/",
    "User-Agent": MERLIN_USER_AGENT,
    "x-merlin-version": "web-merlin",
  };
}

async function* readMerlinEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];

  function flush() {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") return "done";
    try {
      return JSON.parse(payload);
    } catch {
      return { data: { content: payload } };
    }
  }

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          const parsed = flush();
          if (parsed === "done") return;
          if (parsed) yield parsed;
          continue;
        }
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith("data:")) dataLines.push(buffer.trim().slice(5).trimStart());
    const tail = flush();
    if (tail && tail !== "done") yield tail;
  } finally {
    reader.releaseLock();
  }
}

function extractContent(event) {
  const value =
    event?.data?.content ??
    event?.data?.text ??
    event?.content ??
    event?.text ??
    event?.message?.content ??
    "";

  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.text || "").join("");
  if (value && typeof value === "object") return value.text || value.content || JSON.stringify(value);
  return "";
}

async function* extractMerlinContent(eventStream, signal) {
  for await (const event of readMerlinEvents(eventStream, signal)) {
    const error = event?.error || event?.data?.error || event?.message?.error;
    if (error) {
      yield { error: typeof error === "string" ? error : JSON.stringify(error), done: true };
      return;
    }

    const content = extractContent(event);
    if (content) yield { delta: content };

    const status = String(event?.status || event?.data?.status || "").toUpperCase();
    if (event?.final || event?.done || status === "COMPLETED" || status === "DONE") break;
  }
  yield { done: true };
}

function buildStreamingResponse(eventStream, model, cid, created, signal) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
        })));

        let fullContent = "";
        for await (const chunk of extractMerlinContent(eventStream, signal)) {
          if (chunk.error) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: `[Error: ${chunk.error}]` }, finish_reason: null, logprobs: null }],
            })));
            break;
          }
          if (chunk.done) break;
          if (chunk.delta) fullContent += chunk.delta;
        }

        const sanitized = sanitizeMerlinContent(fullContent);
        if (sanitized) {
          controller.enqueue(encoder.encode(sseChunk({
            id: cid,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: sanitized }, finish_reason: null, logprobs: null }],
          })));
        }

        controller.enqueue(encoder.encode(sseChunk({
          id: cid,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: `[Stream error: ${err.message || String(err)}]` }, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
  });
}

async function buildNonStreamingResponse(eventStream, model, cid, created, promptText, signal) {
  let fullContent = "";

  for await (const chunk of extractMerlinContent(eventStream, signal)) {
    if (chunk.error) {
      return new Response(JSON.stringify({
        error: { message: chunk.error, type: "upstream_error", code: "MERLIN_ERROR" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
    if (chunk.done) break;
    if (chunk.delta) fullContent += chunk.delta;
  }

  fullContent = sanitizeMerlinContent(fullContent);

  const promptTokens = Math.ceil(String(promptText || "").length / 4);
  const completionTokens = Math.ceil(fullContent.length / 4);
  return new Response(JSON.stringify({
    id: cid,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: fullContent },
      finish_reason: "stop",
      logprobs: null,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export async function validateMerlinToken(token, { proxyOptions = null, signal } = {}) {
  const normalized = normalizeMerlinToken(token);
  if (!normalized) return { valid: false, error: "Merlin session token is required" };

  const body = buildMerlinRequest(MERLIN_DEFAULT_MODEL, {
    messages: [{ role: "user", content: "ping" }],
  });

  const response = await fetchMerlin(MERLIN_CHAT_API, {
    method: "POST",
    headers: buildMerlinHeaders(normalized),
    body: JSON.stringify(body),
    signal,
  }, proxyOptions);

  if (response.status === 401 || response.status === 403) {
    return { valid: false, error: "Merlin session token is invalid or expired" };
  }

  if (response.status >= 500) {
    return { valid: false, error: `Merlin validation failed with HTTP ${response.status}` };
  }

  return { valid: true, error: null };
}

export class MerlinExecutor extends BaseExecutor {
  constructor() {
    super("merlin", PROVIDERS.merlin);
  }

  async refreshCredentials(credentials, log) {
    return refreshProviderCredentials("merlin", credentials, log);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Missing or empty messages array", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: MERLIN_CHAT_API, headers: {}, transformedBody: body };
    }

    let didRefresh = false;
    if (credentials?.refreshToken && this.needsRefresh(credentials)) {
      const refreshed = await this.refreshCredentials(credentials, log);
      if (refreshed?.accessToken) {
        Object.assign(credentials, refreshed);
        didRefresh = true;
        log?.info?.("MERLIN", "Refreshed session token before request");
      }
    }

    let token = normalizeMerlinToken(credentials?.accessToken || credentials?.apiKey);
    if (!token) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Missing Merlin session token", type: "invalid_request" },
      }), { status: 401, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: MERLIN_CHAT_API, headers: {}, transformedBody: body };
    }

    const parsed = parseOpenAIMessages(messages);
    if (!parsed.current.trim()) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Empty query after processing messages", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: MERLIN_CHAT_API, headers: {}, transformedBody: body };
    }

    const merlinBody = buildMerlinRequest(model || MERLIN_DEFAULT_MODEL, body);
    let headers = buildMerlinHeaders(token);

    log?.info?.("MERLIN", `Query to ${model || MERLIN_DEFAULT_MODEL}, len=${parsed.current.length}`);

    let response;
    try {
      response = await fetchMerlin(MERLIN_CHAT_API, {
        method: "POST",
        headers,
        body: JSON.stringify(merlinBody),
        signal,
      }, proxyOptions);
    } catch (err) {
      log?.error?.("MERLIN", `Fetch failed: ${err.message || String(err)}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `Merlin connection failed: ${err.message || String(err)}`, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: MERLIN_CHAT_API, headers, transformedBody: merlinBody };
    }

    if ((response.status === 401 || response.status === 403) && credentials?.refreshToken && !didRefresh) {
      const refreshed = await this.refreshCredentials(credentials, log);
      if (refreshed?.accessToken) {
        Object.assign(credentials, refreshed);
        token = normalizeMerlinToken(credentials.accessToken);
        headers = buildMerlinHeaders(token);
        didRefresh = true;
        log?.info?.("MERLIN", "Refreshed session token after auth failure; retrying request");
        try {
          response = await fetchMerlin(MERLIN_CHAT_API, {
            method: "POST",
            headers,
            body: JSON.stringify(merlinBody),
            signal,
          }, proxyOptions);
        } catch (err) {
          log?.error?.("MERLIN", `Fetch retry failed: ${err.message || String(err)}`);
          const errResp = new Response(JSON.stringify({
            error: { message: `Merlin connection failed after refresh: ${err.message || String(err)}`, type: "upstream_error" },
          }), { status: 502, headers: { "Content-Type": "application/json" } });
          return { response: errResp, url: MERLIN_CHAT_API, headers, transformedBody: merlinBody };
        }
      }
    }

    if (!response.ok) {
      const status = response.status;
      let errMsg = `Merlin returned HTTP ${status}`;
      if (status === 401 || status === 403) {
        errMsg = credentials?.refreshToken
          ? "Merlin auth failed and automatic refresh did not recover. Re-import the full session JSON from getmerlin.in."
          : "Merlin auth failed. Re-import the full session JSON from getmerlin.in so auto-refresh can be enabled.";
      }
      else if (status === 429) errMsg = "Merlin rate limited this session. Wait a moment and retry.";
      log?.warn?.("MERLIN", errMsg);
      const errResp = new Response(JSON.stringify({
        error: { message: errMsg, type: "upstream_error", code: `HTTP_${status}` },
      }), { status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: MERLIN_CHAT_API, headers, transformedBody: merlinBody };
    }

    if (!response.body) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Merlin returned empty response body", type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: MERLIN_CHAT_API, headers, transformedBody: merlinBody };
    }

    const cid = `chatcmpl-merlin-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    const finalResponse = stream
      ? new Response(buildStreamingResponse(response.body, model, cid, created, signal), {
          status: 200,
          headers: { ...SSE_HEADERS_NO_BUFFER },
        })
      : await buildNonStreamingResponse(response.body, model, cid, created, parsed.current, signal);

    return { response: finalResponse, url: MERLIN_CHAT_API, headers, transformedBody: merlinBody };
  }
}

export default MerlinExecutor;
