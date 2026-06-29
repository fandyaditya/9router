import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MerlinExecutor,
  buildMerlinHeaders,
  buildMerlinRequest,
  normalizeMerlinToken,
  parseMerlinSessionData,
  parseOpenAIMessages,
  sanitizeMerlinContent,
  validateMerlinToken,
} from "../../open-sse/executors/merlin.js";
import { getProviderModels } from "../../open-sse/config/providerModels.js";
import { refreshMerlinToken } from "../../open-sse/services/tokenRefresh/providers.js";

const originalFetch = global.fetch;

function mockMerlinStream(events) {
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(new Blob([`${chunks}data: [DONE]\n\n`]).stream(), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("Merlin token helpers", () => {
  it("normalizes raw, bearer, env, and JSON tokens", () => {
    expect(normalizeMerlinToken("Bearer abc")).toBe("abc");
    expect(normalizeMerlinToken("MERLIN_SESSION_TOKEN=abc")).toBe("abc");
    expect(normalizeMerlinToken("{\"idToken\":\"jwt-token\"}")).toBe("jwt-token");
    expect(normalizeMerlinToken("\"quoted\"")).toBe("quoted");
  });

  it("parses refresh-capable Merlin session JSON", () => {
    const data = parseMerlinSessionData(JSON.stringify({
      idToken: "id-token",
      refreshToken: "refresh-token",
      expiresIn: "3600",
      email: "user@example.com",
      apiKey: "firebase-key",
      localId: "uid-1",
    }));

    expect(data.accessToken).toBe("id-token");
    expect(data.refreshToken).toBe("refresh-token");
    expect(data.expiresIn).toBe(3600);
    expect(data.email).toBe("user@example.com");
    expect(data.firebaseApiKey).toBe("firebase-key");
    expect(data.localId).toBe("uid-1");
  });

  it("parses Merlin session endpoint JSON with nested user tokens", () => {
    const data = parseMerlinSessionData(JSON.stringify({
      user: {
        accessToken: "nested-id-token",
        refreshToken: "nested-refresh-token",
        expiresAt: 1782718046,
        email: "user@example.com",
        id: "uid-1",
        uid: "uid-1",
        planName: "Merlin Pro",
      },
      expires: "2026-06-29T07:27:26.000Z",
    }));

    expect(data.accessToken).toBe("nested-id-token");
    expect(data.idToken).toBe("nested-id-token");
    expect(data.refreshToken).toBe("nested-refresh-token");
    expect(data.expiresAt).toBe(1782718046);
    expect(data.email).toBe("user@example.com");
    expect(data.localId).toBe("uid-1");
  });

  it("parses Firebase auth IndexedDB records used by Merlin", () => {
    const data = parseMerlinSessionData(JSON.stringify({
      fbase_key: "firebase:authUser:firebase-key-from-storage:[DEFAULT]",
      value: {
        apiKey: "firebase-key",
        email: "user@example.com",
        uid: "uid-1",
        stsTokenManager: {
          accessToken: "indexed-access-token",
          refreshToken: "indexed-refresh-token",
          expirationTime: "1782720035245",
        },
      },
    }));

    expect(data.accessToken).toBe("indexed-access-token");
    expect(data.idToken).toBe("indexed-access-token");
    expect(data.refreshToken).toBe("indexed-refresh-token");
    expect(data.expiresAt).toBe("1782720035245");
    expect(data.firebaseApiKey).toBe("firebase-key");
    expect(data.email).toBe("user@example.com");
    expect(data.localId).toBe("uid-1");
  });

  it("falls back to the Firebase storage key when apiKey is not present", () => {
    const data = parseMerlinSessionData({
      fbase_key: "firebase:authUser:firebase-key-from-storage:[DEFAULT]",
      value: {
        stsTokenManager: {
          accessToken: "indexed-access-token",
          refreshToken: "indexed-refresh-token",
        },
      },
    });

    expect(data.firebaseApiKey).toBe("firebase-key-from-storage");
  });

  it("builds browser-like Merlin auth headers", () => {
    const headers = buildMerlinHeaders("Bearer token-1");
    expect(headers.Authorization).toBe("Bearer token-1");
    expect(headers["x-merlin-version"]).toBe("web-merlin");
    expect(headers.Origin).toBe("https://www.getmerlin.in");
  });
});

describe("Merlin request mapping", () => {
  it("extracts system, history, and current user message", () => {
    const parsed = parseOpenAIMessages([
      { role: "system", content: "Be brief" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: [{ type: "text", text: "Q2" }] },
    ]);

    expect(parsed.system).toBe("Be brief");
    expect(parsed.history).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
    ]);
    expect(parsed.current).toBe("Q2");
  });

  it("builds Merlin unified chat payload without enabling Merlin-side tools", () => {
    const body = {
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hello" },
      ],
      webAccess: true,
      tools: [{
        type: "function",
        function: { name: "Search", description: "Search the web" },
      }],
    };
    const request = buildMerlinRequest("gpt-5", body);

    expect(request.mode).toBe("UNIFIED_CHAT");
    expect(request.model).toBe("gpt-5");
    expect(request.message.content).toBe("Hello");
    expect(request.message.context).toContain("Be brief");
    expect(request.message.context).toContain("Merlin built-in tools and modes");
    expect(request.message.context).toContain("Search, web access, browser, document, image, code");
    expect(request.message.context).not.toContain("- Search:");
    expect(request.metadata.webAccess).toBe(false);
  });

  it("removes Merlin internal-tool canned responses", () => {
    const searchOff = `I tried looking up-to-date information as a necessary step in response generation, but Search is off. To get more up-to-date and accurate information on this topic, I’d need you to turn Search on. You can do that by clicking on the 🌐 (globe) icon in the Chat box below.


  !Instructions 


  Once you’re done, you can retry this prompt.`;

    const imageOff = "Please enable the image generation tool to continue, then try again.";
    const documentOff = "I tried reading the attached document as a necessary step in response generation, but document tools are unavailable. Once you're done, you can retry this prompt.";

    expect(sanitizeMerlinContent(searchOff)).toBe("");
    expect(sanitizeMerlinContent(imageOff)).toBe("");
    expect(sanitizeMerlinContent(documentOff)).toBe("");
    expect(sanitizeMerlinContent(`Answer first.\n\n${searchOff}\n\nAnswer after.`)).toBe("Answer first.\n\nAnswer after.");
  });
});

describe("validateMerlinToken", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("accepts a 200 response", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockMerlinStream([{ data: { content: "ok" } }]));
    const result = await validateMerlinToken("token");
    expect(result.valid).toBe(true);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer token");
  });

  it("rejects 401 and 403 responses", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(validateMerlinToken("bad")).resolves.toEqual({
      valid: false,
      error: "Merlin session token is invalid or expired",
    });
  });

  it("accepts non-auth probe responses that show the token reached Merlin", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(validateMerlinToken("token")).resolves.toEqual({ valid: true, error: null });
  });
});

describe("MerlinExecutor.execute", () => {
  let capturedUrl;
  let capturedOpts;
  let capturedBody;

  beforeEach(() => {
    capturedUrl = null;
    capturedOpts = null;
    capturedBody = null;
    global.fetch = vi.fn(async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      capturedBody = JSON.parse(opts.body);
      return mockMerlinStream([
        { data: { content: "hello " } },
        { data: { content: "world" } },
      ]);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts to Merlin and converts non-streaming SSE to OpenAI JSON", async () => {
    const exec = new MerlinExecutor();
    const result = await exec.execute({
      model: "gpt-5",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      credentials: { accessToken: "token-1" },
    });

    expect(capturedUrl).toBe("https://arcane.getmerlin.in/v1/thread/unified");
    expect(capturedOpts.headers.Authorization).toBe("Bearer token-1");
    expect(capturedBody.model).toBe("gpt-5");
    expect(capturedBody.message.content).toBe("hi");

    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("hello world");
    expect(json.object).toBe("chat.completion");
  });

  it("converts Merlin SSE to OpenAI chat chunks", async () => {
    const exec = new MerlinExecutor();
    const result = await exec.execute({
      model: "gpt-5",
      body: { messages: [{ role: "user", content: "hi" }], stream: true },
      stream: true,
      credentials: { accessToken: "token-1" },
    });

    const text = await result.response.text();
    expect(text).toContain("\"object\":\"chat.completion.chunk\"");
    expect(text).toContain("\"content\":\"hello world\"");
    expect(text).toContain("data: [DONE]");
  });

  it("strips Merlin Search-disabled artifacts from non-streaming responses", async () => {
    const searchOff = "I tried looking up-to-date information as a necessary step in response generation, but Search is off. To get more up-to-date and accurate information on this topic, I’d need you to turn Search on. You can do that by clicking on the 🌐 (globe) icon in the Chat box below.\n\n!Instructions\n\nOnce you’re done, you can retry this prompt.";
    global.fetch = vi.fn(async () => mockMerlinStream([{ data: { content: searchOff } }]));

    const exec = new MerlinExecutor();
    const result = await exec.execute({
      model: "gpt-5",
      body: { messages: [{ role: "user", content: "latest news?" }], stream: false },
      stream: false,
      credentials: { accessToken: "token-1" },
    });

    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("");
  });

  it("refreshes expired Merlin credentials before calling the chat API", async () => {
    const fetchCalls = [];
    global.fetch = vi.fn(async (url, opts) => {
      fetchCalls.push({ url, opts });
      if (String(url).startsWith("https://securetoken.googleapis.com")) {
        return new Response(JSON.stringify({
          id_token: "fresh-id-token",
          refresh_token: "fresh-refresh-token",
          expires_in: "3600",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return mockMerlinStream([{ data: { content: "fresh" } }]);
    });

    const exec = new MerlinExecutor();
    const credentials = {
      accessToken: "expired-id-token",
      refreshToken: "expired-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      providerSpecificData: { firebaseApiKey: "firebase-key" },
    };

    const result = await exec.execute({
      model: "gpt-5",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      credentials,
    });

    expect(fetchCalls[0].url).toBe("https://securetoken.googleapis.com/v1/token?key=firebase-key");
    expect(fetchCalls[1].opts.headers.Authorization).toBe("Bearer fresh-id-token");
    expect(credentials.accessToken).toBe("fresh-id-token");
    expect(credentials.refreshToken).toBe("fresh-refresh-token");
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("fresh");
  });

  it("refreshes and retries once when Merlin rejects an otherwise unexpired token", async () => {
    const fetchCalls = [];
    global.fetch = vi.fn(async (url, opts) => {
      fetchCalls.push({ url, opts });
      if (String(url).startsWith("https://securetoken.googleapis.com")) {
        return new Response(JSON.stringify({
          id_token: "retry-id-token",
          refresh_token: "retry-refresh-token",
          expires_in: "3600",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (fetchCalls.filter((call) => String(call.url).includes("arcane.getmerlin.in")).length === 1) {
        return new Response("expired", { status: 401 });
      }
      return mockMerlinStream([{ data: { content: "retried" } }]);
    });

    const exec = new MerlinExecutor();
    const credentials = {
      accessToken: "stale-id-token",
      refreshToken: "stale-refresh-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      providerSpecificData: { firebaseApiKey: "firebase-key" },
    };

    const result = await exec.execute({
      model: "gpt-5",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      credentials,
    });

    expect(fetchCalls[0].opts.headers.Authorization).toBe("Bearer stale-id-token");
    expect(fetchCalls[1].url).toBe("https://securetoken.googleapis.com/v1/token?key=firebase-key");
    expect(fetchCalls[2].opts.headers.Authorization).toBe("Bearer retry-id-token");
    expect(credentials.accessToken).toBe("retry-id-token");
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("retried");
  });

  it("returns a clear auth error when no token is available", async () => {
    const exec = new MerlinExecutor();
    const result = await exec.execute({
      model: "gpt-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
    });
    const json = await result.response.json();
    expect(result.response.status).toBe(401);
    expect(json.error.message).toContain("Missing Merlin session token");
  });
});

describe("refreshMerlinToken", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("exchanges a Firebase refresh token for a fresh Merlin ID token", async () => {
    let capturedUrl;
    let capturedBody;
    global.fetch = vi.fn(async (url, opts) => {
      capturedUrl = url;
      capturedBody = opts.body;
      return new Response(JSON.stringify({
        id_token: "new-id-token",
        refresh_token: "new-refresh-token",
        expires_in: "3600",
        user_id: "uid-1",
        project_id: "merlin-project",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const result = await refreshMerlinToken("old-refresh", {
      providerSpecificData: { firebaseApiKey: "firebase-key", authMethod: "session_token" },
    });

    expect(capturedUrl).toBe("https://securetoken.googleapis.com/v1/token?key=firebase-key");
    expect(String(capturedBody)).toContain("grant_type=refresh_token");
    expect(String(capturedBody)).toContain("refresh_token=old-refresh");
    expect(result.accessToken).toBe("new-id-token");
    expect(result.refreshToken).toBe("new-refresh-token");
    expect(result.expiresIn).toBe(3600);
    expect(result.providerSpecificData.firebaseApiKey).toBe("firebase-key");
    expect(result.providerSpecificData.authMethod).toBe("session_token");
    expect(result.lastRefreshAt).toBeTruthy();
  });

  it("uses Merlin's built-in Firebase API key when imported JSON has no apiKey", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      id_token: "default-key-id-token",
      refresh_token: "default-key-refresh-token",
      expires_in: "3600",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await refreshMerlinToken("old-refresh-default-key", {});
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(global.fetch.mock.calls[0][0]).toBe("https://securetoken.googleapis.com/v1/token?key=AIzaSyAvCgtQ4XbmlQGIynDT-v_M8eLaXrKmtiM");
    expect(String(global.fetch.mock.calls[0][1].body)).toContain("refresh_token=old-refresh-default-key");
    expect(result.accessToken).toBe("default-key-id-token");
    expect(result.providerSpecificData.firebaseApiKey).toBe("AIzaSyAvCgtQ4XbmlQGIynDT-v_M8eLaXrKmtiM");
  });
});

describe("Merlin static catalog", () => {
  it("exposes the verified Merlin model picker catalog through provider models", () => {
    const models = getProviderModels("merlin");
    expect(models.map((m) => m.id)).toEqual([
      "gemini-2.5-flash-lite",
      "minimax-m2.7",
      "claude-4.5-haiku",
      "kimi-k2.6",
      "grok-4.3",
      "deepseek-v4-pro",
      "gemini-3.1-pro",
      "gemini-3.5-flash",
      "glm-5.1",
      "gemini-3.1-flash-lite",
      "gpt-5.5",
      "gpt-5.4",
      "claude-4.6-sonnet",
      "claude-4.8-opus",
    ]);
  });
});
