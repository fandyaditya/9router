import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { parseMerlinSessionData, validateMerlinToken } from "open-sse/executors/merlin.js";
import { MERLIN_FIREBASE_API_KEY } from "open-sse/services/tokenRefresh/providers.js";

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeExpiresAt(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const numeric = Number(value.trim());
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * POST /api/oauth/merlin/import
 * Import a Merlin web/desktop session token. Merlin does not expose a
 * standard OAuth flow, so refresh depends on Firebase metadata in the import.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const rawToken =
      body.sessionData ||
      body.session ||
      body.accessToken ||
      body.sessionToken ||
      body.token ||
      body;
    const tokenData = parseMerlinSessionData(rawToken);
    const accessToken = tokenData.accessToken;

    if (!accessToken) {
      return NextResponse.json(
        { error: "Merlin session token is required" },
        { status: 400 }
      );
    }

    const validation = await validateMerlinToken(accessToken);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || "Failed to validate Merlin token" },
        { status: 400 }
      );
    }

    const payload = decodeJwtPayload(accessToken);
    const email = tokenData.email || payload?.email || payload?.preferred_username || null;
    const name = body.name || email || "Merlin Session";
    const expiresIn = tokenData.expiresIn || null;
    const firebaseApiKey =
      body.firebaseApiKey?.trim?.() ||
      body.firebase_api_key?.trim?.() ||
      tokenData.firebaseApiKey ||
      MERLIN_FIREBASE_API_KEY;
    const expiresAt =
      normalizeExpiresAt(tokenData.expiresAt) ||
      (expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : payload?.exp
          ? new Date(payload.exp * 1000).toISOString()
          : null);

    const connection = await createProviderConnection({
      provider: "merlin",
      authType: "oauth",
      accessToken,
      refreshToken: tokenData.refreshToken || null,
      idToken: tokenData.idToken || accessToken,
      expiresIn,
      expiresAt,
      email,
      name,
      providerSpecificData: {
        authMethod: "session_token",
        source: "manual_import",
        tokenExp: payload?.exp || null,
        localId: tokenData.localId || payload?.user_id || payload?.sub || null,
        projectId: tokenData.projectId || payload?.aud || null,
        firebaseApiKey,
        planName: tokenData.planName || payload?.planName || null,
        userPlan: tokenData.userPlan || payload?.userPlan || null,
        role: tokenData.role || payload?.role || null,
        aggregator: tokenData.aggregator || payload?.aggregator || null,
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        name: connection.name,
      },
    });
  } catch (error) {
    console.log("Merlin import token error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    provider: "merlin",
    method: "session_token",
    instructions: [
      "Sign in at https://www.getmerlin.in.",
      "Open https://session.getmerlin.in/?from=web in the same browser session.",
      "Copy the full JSON response and paste it into 9Router so refreshToken and expiry metadata are preserved.",
      "The Merlin Firebase client key is built in for auto-refresh, so the session JSON does not need to include apiKey.",
    ],
    requiredFields: [
      {
        name: "sessionToken",
        label: "Full Session JSON",
        description: "Full JSON from session.getmerlin.in/?from=web, including user.accessToken, user.refreshToken, and user.expiresAt.",
        type: "textarea",
      },
      {
        name: "firebaseApiKey",
        label: "Firebase API Key",
        description: "Optional value from browser DevTools > Application > IndexedDB > firebaseLocalStorageDb > firebaseLocalStorage > value.apiKey.",
        type: "text",
        optional: true,
      },
    ],
  });
}
