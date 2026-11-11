import type { D1Database } from "@cloudflare/workers-types";
import { sendNotification, generateRequestDetails } from "web-push-neo";
import { removeSubscription, type PushSubscriptionRow } from "./subscriptions";

export interface PushNotificationPayload {
  tag?: string;
  title?: string;
  body?: string;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
}

export interface PushSendOptions {
  /** VAPID subject (mailto: or https URL). */
  subject: string;
  /** VAPID public key (base64url). */
  publicKey: string;
  /** VAPID private key (PEM or base64url). */
  privateKey: string;
}

export interface PushDeliveryResult {
  sent: number;
  removed: number;
  errors: Array<{
    endpoint: string;
    statusCode: number | undefined;
    error: string;
  }>;
}

/**
 * Send a notification to every stored subscription.
 *
 * - Passes VAPID details on each call (read from env bindings).
 * - Batch-delivers to all subscribers.
 * - Removes subscriptions that respond 404/410 (expired/gone) so the database
 *   does not accumulate stale endpoints.
 *
 * Returns counts so callers can log a summary.
 */
export async function sendPushNotifications(
  db: D1Database,
  opts: PushSendOptions,
  payload: PushNotificationPayload,
): Promise<PushDeliveryResult> {
  const result: PushDeliveryResult = { sent: 0, removed: 0, errors: [] };

  let cursor = "";
  for (;;) {
    const page = (
      await db
        .prepare(
          "SELECT endpoint,p256dh,auth,created_at,preferences FROM push_subscriptions WHERE endpoint>? ORDER BY endpoint LIMIT 100",
        )
        .bind(cursor)
        .all<PushSubscriptionRow>()
    ).results;
    if (!page.length) break;
    cursor = page[page.length - 1]!.endpoint;
    const subscriptions = page.filter((sub) => {
      const type = payload.data?.alertType;
      if (!type) return true;
      const p = JSON.parse(sub.preferences ?? "{}");
      return type === "rain-forecast"
        ? p.rainForecast !== false
        : p.temperatureForecast !== false;
    });
    for (let i = 0; i < subscriptions.length; i += 10) {
      const batch = subscriptions.slice(i, i + 10);
      await Promise.all(
        batch.map(async (sub) => {
          try {
            await sendNotification(
              {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
              },
              JSON.stringify(
                localizeForecast(
                  payload,
                  JSON.parse(sub.preferences ?? "{}").locale,
                ),
              ),
              {
                vapidDetails: {
                  subject: opts.subject,
                  publicKey: opts.publicKey,
                  privateKey: opts.privateKey,
                },
                TTL: 60 * 60,
                signal: AbortSignal.timeout(20_000),
              },
            );
            result.sent++;
          } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
              // Subscription is no longer valid — clean it up.
              await removeSubscription(db, sub.endpoint);
              result.removed++;
            } else {
              result.errors.push({
                endpoint: "[redacted]",
                statusCode,
                error: "push-provider-error",
              });
            }
          }
        }),
      );
    }

    if (page.length < 100) break;
  }
  return result;
}

/** Send a single notification to one subscription (used for targeted tests). */
export async function sendPushNotificationToOne(
  opts: PushSendOptions,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: PushNotificationPayload,
  ttl = 3600,
): Promise<void> {
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 3072)
    throw Object.assign(new Error("payload-too-large"), { statusCode: 400 });
  const details = await generateRequestDetails(
    subscription,
    JSON.stringify(payload),
    {
      vapidDetails: opts,
      TTL: ttl,
    },
  );
  const response = await fetch(details.endpoint, {
    method: details.method,
    headers: details.headers,
    body: details.body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw Object.assign(new Error("push-provider-error"), {
      statusCode: response.status,
      retryAfter: response.headers.get("retry-after"),
    });
}

/** Localize the existing forecast templates without changing their thresholds or numeric values. */
export function localizeForecast(
  payload: PushNotificationPayload,
  locale: string,
): PushNotificationPayload {
  if (!payload.data?.alertType || !["pt-BR", "es"].includes(locale))
    return payload;
  const pt = locale === "pt-BR";
  const title =
    payload.data.alertType === "rain-forecast"
      ? pt
        ? "Previs?o de chuva"
        : "Pron?stico de lluvia"
      : payload.data.alertType === "low-temperature"
        ? pt
          ? "Previs?o de frio"
          : "Pron?stico de fr?o"
        : pt
          ? "Varia??o de temperatura prevista"
          : "Cambio de temperatura previsto";
  let body = payload.body ?? "";
  const replacements: Array<[RegExp, string]> = [
    [
      /Rain is expected around /,
      pt ? "Chuva prevista por volta de " : "Lluvia prevista alrededor de ",
    ],
    [
      / with a (.+)% chance\./,
      pt ? " com $1% de probabilidade." : " con $1% de probabilidad.",
    ],
    [
      /Temperature may fall to /,
      pt ? "A temperatura pode cair para " : "La temperatura puede bajar a ",
    ],
    [/ around /, pt ? " por volta de " : " alrededor de "],
    [/Forecast ranges from /, pt ? "Previs?o de " : "Pron?stico de "],
    [/ to /, pt ? " a " : " a "],
    [
      /Temperature may change by /,
      pt ? "A temperatura pode variar " : "La temperatura puede variar ",
    ],
    [/ between /, pt ? " entre " : " entre "],
    [/ and /, pt ? " e " : " y "],
  ];
  for (const [pattern, replacement] of replacements)
    body = body.replace(pattern, replacement);
  return {
    ...payload,
    title,
    body,
    tag: `forecast:${String(payload.data.alertType)}:${String(payload.data.eventTime)}`,
  };
}
