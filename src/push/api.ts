import type { D1Database } from "@cloudflare/workers-types";
import { insertSubscription, removeSubscription } from "./subscriptions";
import { normalizePublicKey, validatePublicKeyFormat } from "./vapid";

/**
 * Public HTTP handlers for anonymous push subscription management.
 *
 * - POST /api/push-subscribe   — store a PushSubscription
 * - POST /api/push-unsubscribe — remove a PushSubscription
 * - GET  /api/push/public-key  — expose the VAPID public key to the browser
 */

export interface PushApiEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function pathMatches(url: URL, path: string): boolean {
  return url.pathname === path;
}

/**
 * Route a push-related API request. Returns a Response for recognized
 * endpoints, or null if the path is handled elsewhere.
 */
export async function handlePushApi(
  request: Request,
  env: PushApiEnv,
): Promise<Response | null> {
  const url = new URL(request.url);

  // Expose the VAPID public key so the client can create a subscription.
  if (pathMatches(url, "/api/push/public-key") && request.method === "GET") {
    if (!env.VAPID_PUBLIC_KEY) {
      return json({ error: "VAPID_PUBLIC_KEY is not configured" }, 500);
    }
    const normalized = normalizePublicKey(env.VAPID_PUBLIC_KEY);
    const invalid = validatePublicKeyFormat(normalized);
    if (invalid) {
      return json({ error: invalid }, 500);
    }
    return json({ publicKey: normalized });
  }

  // Subscribe — store the endpoint + keys.
  if (pathMatches(url, "/api/push-subscribe") && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const { endpoint, keys } = (body ?? {}) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    if (
      typeof endpoint !== "string" ||
      endpoint.length === 0 ||
      !keys ||
      typeof keys.p256dh !== "string" ||
      typeof keys.auth !== "string"
    ) {
      return json({ error: "Invalid subscription payload" }, 400);
    }
    await insertSubscription(env.DB, {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
    return json({ ok: true });
  }

  // Unsubscribe — remove the endpoint.
  if (pathMatches(url, "/api/push-unsubscribe") && request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const { endpoint } = (body ?? {}) as { endpoint?: unknown };
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      return json({ error: "Invalid endpoint" }, 400);
    }
    await removeSubscription(env.DB, endpoint);
    return json({ ok: true });
  }

  return null;
}