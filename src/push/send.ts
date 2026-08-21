import type { D1Database } from "@cloudflare/workers-types";
import { sendNotification } from "web-push-neo";
import { listSubscriptions, removeSubscription } from "./subscriptions";

export interface PushNotificationPayload {
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
  errors: Array<{ endpoint: string; statusCode: number | undefined; error: string }>;
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
  const subscriptions = await listSubscriptions(db);

  const result: PushDeliveryResult = { sent: 0, removed: 0, errors: [] };

  // Batch processing is acceptable per requirements.
  const BATCH_SIZE = 50;
  for (let i = 0; i < subscriptions.length; i += BATCH_SIZE) {
    const batch = subscriptions.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (sub) => {
        try {
          await sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify(payload),
            {
              vapidDetails: {
                subject: opts.subject,
                publicKey: opts.publicKey,
                privateKey: opts.privateKey,
              },
              TTL: 60 * 60, // keep for delivery for an hour, then expire
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
              endpoint: sub.endpoint,
              statusCode,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }),
    );
  }

  return result;
}

/** Send a single notification to one subscription (used for targeted tests). */
export async function sendPushNotificationToOne(
  opts: PushSendOptions,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: PushNotificationPayload,
): Promise<void> {
  await sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: {
      subject: opts.subject,
      publicKey: opts.publicKey,
      privateKey: opts.privateKey,
    },
    TTL: 60 * 60,
  });
}