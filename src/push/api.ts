import type { D1Database } from "@cloudflare/workers-types";
import type { PushPreferences } from "../../shared/weather";
import type { Subscription } from "./outbox";
import { insertSubscription } from "./subscriptions";
import { normalizePublicKey, validatePublicKeyFormat } from "./vapid";
import { buildPushSendOptions } from "./alerts";
import { sendPushNotificationToOne } from "./send";
export interface PushApiEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  DISABLE_ALERTS?: string;
}
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (code: string, status = 400) =>
  json({ error: { code, message: code, retryable: status >= 500 } }, status);
export async function hashToken(token: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      (u.hostname === "fcm.googleapis.com" ||
        u.hostname === "updates.push.services.mozilla.com" ||
        u.hostname === "web.push.apple.com" ||
        u.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}
function validKey(v: unknown, length: number) {
  if (typeof v !== "string" || v.length > 128 || !/^[\w+/-]+={0,2}$/.test(v))
    return false;
  try {
    const decoded = atob(v.replace(/-/g, "+").replace(/_/g, "/"));
    return (
      decoded.length === length &&
      (length !== 65 || decoded.charCodeAt(0) === 4)
    );
  } catch {
    return false;
  }
}
async function preferences(
  db: D1Database,
  value: unknown,
): Promise<PushPreferences | null> {
  if (!value || typeof value !== "object") return null;
  const p = value as PushPreferences;
  if (
    !["all", "selected"].includes(p.stationScope) ||
    !["pt-BR", "en", "es"].includes(p.locale) ||
    !Array.isArray(p.stationIds) ||
    p.stationIds.length > 100 ||
    ![p.rainStart, p.rainForecast, p.temperatureForecast].every(
      (v) => typeof v === "boolean",
    ) ||
    p.stationIds.some((v) => typeof v !== "string" || v.length > 128) ||
    new Set(p.stationIds).size !== p.stationIds.length
  )
    return null;
  if (p.stationScope === "selected" && p.rainStart && !p.stationIds.length)
    return null;
  const stations = (
    await db.prepare("SELECT id FROM weather_locations").all<{ id: string }>()
  ).results;
  if (p.stationIds.some((id) => !stations.some((s) => s.id === id)))
    return null;
  return {
    stationScope: p.stationScope,
    stationIds: p.stationScope === "all" ? [] : p.stationIds,
    rainStart: p.rainStart,
    rainForecast: p.rainForecast,
    temperatureForecast: p.temperatureForecast,
    locale: p.locale,
  };
}
export async function handlePushApi(
  request: Request,
  env: PushApiEnv,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/api/push/public-key" && request.method === "GET") {
    if (!env.VAPID_PUBLIC_KEY) return fail("service-unavailable", 503);
    const key = normalizePublicKey(env.VAPID_PUBLIC_KEY);
    if (validatePublicKeyFormat(key)) return fail("service-unavailable", 503);
    return json({
      publicKey: key,
      version: 2,
      paused: env.DISABLE_ALERTS === "true",
    });
  }
  if (
    ![
      "/api/push-subscribe",
      "/api/push-unsubscribe",
      "/api/push/status",
      "/api/push/preferences",
      "/api/push/test-device",
    ].includes(path)
  )
    return null;
  if (request.method !== "POST") return fail("method-not-allowed", 405);
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return fail("origin-denied", 403);
  if (Number(request.headers.get("content-length")) > 16384)
    return fail("body-too-large", 413);
  let body: Record<string, any>;
  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16384) {
          await reader.cancel();
          return fail("body-too-large", 413);
        }
        chunks.push(chunk.value);
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(bytes);
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return fail("invalid-body");
  } catch {
    return fail("invalid-json");
  }
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
  const token = bearer ?? body.controlToken;
  const digest =
    typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? await hashToken(token)
      : null;
  const existing =
    typeof body.subscriptionId === "string"
      ? await env.DB.prepare("SELECT * FROM push_subscriptions WHERE id=?")
          .bind(body.subscriptionId)
          .first<Subscription>()
      : typeof body.endpoint === "string"
        ? await env.DB.prepare(
            "SELECT * FROM push_subscriptions WHERE endpoint=?",
          )
            .bind(body.endpoint)
            .first<Subscription>()
        : null;
  if (path === "/api/push-subscribe") {
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) {
      const now = new Date(),
        key = await hashToken(ip + now.toISOString().slice(0, 13));
      const limit = await env.DB.prepare(
        `INSERT INTO push_api_limits(key,count,expires_at) VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<20`,
      )
        .bind(key, new Date(now.getTime() + 7200000).toISOString())
        .run();
      if (!limit.meta.changes) return fail("registration-cooldown", 429);
      await env.DB.prepare(
        "DELETE FROM push_api_limits WHERE key IN (SELECT key FROM push_api_limits WHERE expires_at<? LIMIT 20)",
      )
        .bind(now.toISOString())
        .run();
    }

    if (
      !validEndpoint(body.endpoint) ||
      !validKey(body.keys?.p256dh, 65) ||
      !validKey(body.keys?.auth, 16)
    )
      return fail("invalid-subscription");
    if (body.version !== 2) {
      if (existing?.control_hash) return fail("client-upgrade-required", 409);
      await insertSubscription(env.DB, {
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      });
      return json({ ok: true });
    }
    if (!digest) return fail("invalid-control-token");
    if (
      existing &&
      (existing.control_hash
        ? existing.control_hash !== digest
        : existing.p256dh !== body.keys.p256dh ||
          existing.auth !== body.keys.auth)
    )
      return fail("credential-mismatch", 403);
    const p = await preferences(env.DB, body.preferences);
    if (!p) return fail("invalid-preferences");
    const id = existing?.id ?? crypto.randomUUID(),
      now = new Date().toISOString();
    // Conditional upsert prevents races between promotion and stale/unauthorized clients.
    const saved = await env.DB.prepare(
      `INSERT INTO push_subscriptions(endpoint,p256dh,auth,id,created_at,control_hash,preferences) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,control_hash=excluded.control_hash,preferences=excluded.preferences
      WHERE push_subscriptions.control_hash=excluded.control_hash OR (push_subscriptions.control_hash IS NULL AND push_subscriptions.p256dh=excluded.p256dh AND push_subscriptions.auth=excluded.auth)`,
    )
      .bind(
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        id,
        now,
        digest,
        JSON.stringify(p),
      )
      .run();
    if (!saved.meta.changes) return fail("credential-mismatch", 403);
    const row = await env.DB.prepare(
      "SELECT id FROM push_subscriptions WHERE endpoint=?",
    )
      .bind(body.endpoint)
      .first<{ id: string }>();
    return json({
      ok: true,
      subscriptionId: row!.id,
      syncedAt: now,
      preferences: p,
      paused: env.DISABLE_ALERTS === "true",
    });
  }
  if (path === "/api/push-unsubscribe" && !existing) return json({ ok: true });
  if (!existing) return fail("subscription-not-found", 404);
  if (
    path === "/api/push/status" &&
    !existing.control_hash &&
    body.keys?.p256dh === existing.p256dh &&
    body.keys?.auth === existing.auth
  )
    return json({
      ok: true,
      legacy: true,
      subscriptionId: existing.id,
      preferences: JSON.parse(existing.preferences),
      paused: env.DISABLE_ALERTS === "true",
    });
  const legacy = path === "/api/push-unsubscribe" && !existing.control_hash;
  if (!legacy && (!digest || existing.control_hash !== digest))
    return fail("credential-mismatch", 403);
  if (path === "/api/push/status")
    return json({
      ok: true,
      subscriptionId: existing.id,
      preferences: JSON.parse(existing.preferences),
      paused: env.DISABLE_ALERTS === "true",
    });
  if (path === "/api/push-unsubscribe") {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM push_subscriptions WHERE id=? AND (control_hash=? OR control_hash IS NULL)",
      ).bind(existing.id, digest),
      env.DB.prepare(
        "UPDATE push_deliveries SET status='cancelled' WHERE subscription_id=? AND status IN ('pending','retry','sending')",
      ).bind(existing.id),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/push/preferences") {
    const p = await preferences(env.DB, body.preferences);
    if (!p) return fail("invalid-preferences");
    await env.DB.prepare(
      "UPDATE push_subscriptions SET preferences=? WHERE id=? AND control_hash=?",
    )
      .bind(JSON.stringify(p), existing.id, digest)
      .run();
    return json({
      ok: true,
      preferences: p,
      syncedAt: new Date().toISOString(),
    });
  }
  if (env.DISABLE_ALERTS === "true") return fail("service-paused", 503);
  const opts = buildPushSendOptions(env);
  if (!opts) return fail("service-unavailable", 503);
  const now = new Date();
  const claim = await env.DB.prepare(
    "UPDATE push_subscriptions SET test_at=? WHERE id=? AND (test_at IS NULL OR test_at<=?)",
  )
    .bind(
      now.toISOString(),
      existing.id,
      new Date(now.getTime() - 60000).toISOString(),
    )
    .run();
  if (!claim.meta.changes) return fail("test-cooldown", 429);
  try {
    await sendPushNotificationToOne(
      opts,
      {
        endpoint: existing.endpoint,
        keys: { p256dh: existing.p256dh, auth: existing.auth },
      },
      {
        title: "Meteo Data",
        body:
          JSON.parse(existing.preferences).locale === "pt-BR"
            ? "Teste de notificações deste dispositivo."
            : "Device notification test.",
        tag: "device-test",
        data: { url: "/#chuva" },
      },
      60,
    );
    return json({ ok: true, accepted: true });
  } catch {
    return fail("transport-error", 502);
  }
}
