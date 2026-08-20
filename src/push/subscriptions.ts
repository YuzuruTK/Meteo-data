import type { D1Database } from "@cloudflare/workers-types";

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

/**
 * Persistence for anonymous browser push subscriptions in D1.
 *
 * The `push_subscriptions` table keys rows on the push endpoint URL, which is
 * unique per browser/profile. There is no user account — users are identified
 * entirely by their endpoint.
 */
export async function insertSubscription(
  db: D1Database,
  sub: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  // INSERT OR IGNORE makes subscribing idempotent (duplicates are ignored).
  await db
    .prepare(
      `INSERT OR IGNORE INTO push_subscriptions (endpoint, p256dh, auth)
       VALUES (?, ?, ?)`,
    )
    .bind(sub.endpoint, sub.p256dh, sub.auth)
    .run();
}

export async function removeSubscription(
  db: D1Database,
  endpoint: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`)
    .bind(endpoint)
    .run();
}

export async function listSubscriptions(
  db: D1Database,
): Promise<PushSubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions ORDER BY created_at ASC`,
    )
    .all<PushSubscriptionRow>();
  return result.results ?? [];
}

export async function getSubscription(
  db: D1Database,
  endpoint: string,
): Promise<PushSubscriptionRow | null> {
  const row = await db
    .prepare(
      `SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE endpoint = ?`,
    )
    .bind(endpoint)
    .first<PushSubscriptionRow>();
  return row ?? null;
}