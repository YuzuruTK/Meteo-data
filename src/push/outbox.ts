import type { D1Database } from "@cloudflare/workers-types";
import type { PushPreferences } from "../../shared/weather";
import { fresh, RAIN_THRESHOLD_MM_H } from "../../shared/weather";
import { sendPushNotificationToOne, type PushSendOptions } from "./send";
export interface Subscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  control_hash: string | null;
  preferences: string;
}
interface RainEvent {
  rate_mm_h: number;
  id: string;
  station_id: string;
  station_name: string;
  observed_at: string;
  expires_at: string;
}
interface Delivery {
  batch_id: string;
  subscription_id: string;
  event_ids: string;
  attempt_count: number;
}
export function allows(p: PushPreferences, event: RainEvent): boolean {
  return (
    p.rainStart &&
    (p.stationScope === "all" || p.stationIds.includes(event.station_id))
  );
}
export async function drainRainOutbox(
  db: D1Database,
  vapid: PushSendOptions,
  now = new Date(),
) {
  const started = Date.now();
  const clock = () => new Date(now.getTime() + Date.now() - started);
  const iso = now.toISOString();
  const stats = {
    sent: 0,
    removed: 0,
    errors: [] as Array<{
      endpoint: string;
      statusCode: number | undefined;
      error: string;
    }>,
  };
  const batches = await db
    .prepare(
      "SELECT * FROM push_batches WHERE mode='live' AND prepared=0 ORDER BY created_at LIMIT 4",
    )
    .all<{ id: string; created_at: string; cursor: string }>();
  for (const batch of batches.results) {
    const events = (
      await db
        .prepare("SELECT * FROM rain_events WHERE batch_id=? AND expires_at>?")
        .bind(batch.id, iso)
        .all<RainEvent>()
    ).results;
    const subs = events.length
      ? (
          await db
            .prepare(
              "SELECT * FROM push_subscriptions WHERE id>? AND julianday(created_at)<=julianday(?) ORDER BY id LIMIT 100",
            )
            .bind(batch.cursor, batch.created_at)
            .all<Subscription>()
        ).results
      : [];
    const writes = [];
    for (const sub of subs) {
      const allowed = events.filter((e) =>
        allows(JSON.parse(sub.preferences), e),
      );
      if (!allowed.length) continue;
      const expiry = allowed
        .map((e) => e.expires_at)
        .sort()
        .at(-1)!;
      writes.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO push_deliveries(batch_id,subscription_id,event_ids,next_attempt_at,expires_at) VALUES (?,?,?,?,?)",
          )
          .bind(
            batch.id,
            sub.id,
            JSON.stringify(allowed.map((e) => e.id)),
            iso,
            expiry,
          ),
      );
    }
    writes.push(
      db
        .prepare(
          "UPDATE push_batches SET cursor=?,prepared=? WHERE id=? AND cursor=?",
        )
        .bind(
          subs.at(-1)?.id ?? batch.cursor,
          Number(subs.length < 100),
          batch.id,
          batch.cursor,
        ),
    );
    await db.batch(writes);
  }
  await db
    .prepare(
      "UPDATE push_deliveries SET status='expired',lease_token=NULL WHERE expires_at<=? AND status IN ('pending','retry','sending')",
    )
    .bind(iso)
    .run();
  await db
    .prepare(
      "UPDATE push_deliveries SET status='permanent-failure',error='attempt-limit' WHERE status='sending' AND attempt_count>=3 AND lease_until<=?",
    )
    .bind(iso)
    .run();
  const deliveries = (
    await db
      .prepare(
        `SELECT * FROM push_deliveries WHERE ((status IN ('pending','retry') AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?)) AND expires_at>? ORDER BY next_attempt_at LIMIT 50`,
      )
      .bind(iso, iso, iso)
      .all<Delivery>()
  ).results;
  for (let offset = 0; offset < deliveries.length; offset += 10)
    await Promise.all(
      deliveries.slice(offset, offset + 10).map(async (d) => {
        const claimNow = clock();
        const claimIso = claimNow.toISOString();
        const token = crypto.randomUUID();
        const claimed = await db
          .prepare(
            `UPDATE push_deliveries SET status='sending',lease_token=?,lease_until=?,attempt_count=attempt_count+1 WHERE batch_id=? AND subscription_id=? AND attempt_count<3 AND ((status IN ('pending','retry') AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?))`,
          )
          .bind(
            token,
            new Date(claimNow.getTime() + 90_000).toISOString(),
            d.batch_id,
            d.subscription_id,
            claimIso,
            claimIso,
          )
          .run();
        if (!claimed.meta.changes) return;
        const finish = async (
          status: string,
          error: string | null = null,
          retryAt = new Date(clock().getTime() + 300_000).toISOString(),
        ) => {
          await db
            .prepare(
              "UPDATE push_deliveries SET status=?,error=?,next_attempt_at=?,accepted_at=?,lease_token=NULL WHERE batch_id=? AND subscription_id=? AND lease_token=?",
            )
            .bind(
              status,
              error,
              retryAt,
              status === "accepted" ? clock().toISOString() : null,
              d.batch_id,
              d.subscription_id,
              token,
            )
            .run();
        };
        const sub = await db
          .prepare("SELECT * FROM push_subscriptions WHERE id=?")
          .bind(d.subscription_id)
          .first<Subscription>();
        if (!sub) {
          await finish("cancelled");
          return;
        }
        const preferences: PushPreferences = JSON.parse(sub.preferences);
        const ids: string[] = JSON.parse(d.event_ids);
        const events = (
          await db
            .prepare(
              "SELECT * FROM rain_events WHERE batch_id=? AND expires_at>?",
            )
            .bind(d.batch_id, clock().toISOString())
            .all<RainEvent>()
        ).results;
        const eligible: RainEvent[] = [];
        for (const e of events) {
          if (!ids.includes(e.id) || !allows(preferences, e)) continue;
          const latest = await db
            .prepare(
              "SELECT observed_at,precipitation_rate FROM latest_weather_observations WHERE location_id=?",
            )
            .bind(e.station_id)
            .first<{
              observed_at: string;
              precipitation_rate: number | null;
            }>();
          if (
            latest &&
            fresh(latest.observed_at, clock().getTime()) &&
            latest.precipitation_rate !== null &&
            latest.precipitation_rate >= RAIN_THRESHOLD_MM_H
          )
            eligible.push(e);
        }
        if (!eligible.length) {
          await finish("cancelled");
          return;
        }
        const locale = preferences.locale;
        const title =
          locale === "pt-BR"
            ? "Chuva detectada"
            : locale === "es"
              ? "Lluvia detectada"
              : "Rain detected";
        const url = new URL("https://local.invalid/");
        url.searchParams.set(
          eligible.length === 1 ? "station" : "stations",
          eligible.map((e) => e.station_id).join(","),
        );
        url.searchParams.set("event", d.batch_id);
        url.hash = "chuva";
        const ttl = Math.floor(
          (Math.min(...eligible.map((e) => Date.parse(e.expires_at))) -
            clock().getTime()) /
            1000,
        );
        if (ttl <= 0) {
          await finish("expired");
          return;
        }
        try {
          await sendPushNotificationToOne(
            vapid,
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            {
              title,
              body: eligible
                .map(
                  (e) =>
                    `${e.station_name} · ${new Date(e.observed_at).toLocaleTimeString(locale, { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}`,
                )
                .join("; "),
              tag: `rain:${d.batch_id}:${sub.id}`,
              data: {
                url: url.pathname + url.search + url.hash,
                eventIds: eligible.map((e) => e.id),
                observedAt: eligible[0]!.observed_at,
                expiresAt: eligible.map((e) => e.expires_at).sort()[0],
              },
            },
            ttl,
          );
          await finish("accepted");
          stats.sent++;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await db.batch([
              db
                .prepare("DELETE FROM push_subscriptions WHERE id=?")
                .bind(sub.id),
              db
                .prepare(
                  "UPDATE push_deliveries SET status='cancelled' WHERE subscription_id=? AND status IN ('pending','retry','sending')",
                )
                .bind(sub.id),
            ]);
            stats.removed++;
          } else {
            const retryAfter = (error as { retryAfter?: string }).retryAfter;
            const retryMs = retryAfter
              ? /^\d+$/.test(retryAfter)
                ? now.getTime() + Number(retryAfter) * 1000
                : Date.parse(retryAfter)
              : 0;
            const retryAt = new Date(
              Math.max(
                now.getTime() + 300_000,
                Number.isFinite(retryMs) ? retryMs : 0,
              ),
            ).toISOString();
            await finish(
              (!status || status === 429 || status >= 500) &&
                d.attempt_count < 2
                ? "retry"
                : "permanent-failure",
              status ? `provider-${status}` : "transport-error",
              retryAt,
            );
          }
        }
      }),
    );
  // Bounded, indexed retention; no observations or subscription secrets are copied.
  await db
    .prepare(
      "DELETE FROM push_deliveries WHERE rowid IN (SELECT rowid FROM push_deliveries WHERE expires_at<? LIMIT 100)",
    )
    .bind(new Date(now.getTime() - 7 * 86400000).toISOString())
    .run();
  await db
    .prepare(
      "DELETE FROM rain_events WHERE id IN (SELECT id FROM rain_events WHERE expires_at<? AND NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.batch_id=rain_events.batch_id) LIMIT 100)",
    )
    .bind(new Date(now.getTime() - 30 * 86400000).toISOString())
    .run();
  await db
    .prepare(
      "DELETE FROM push_batches WHERE id IN (SELECT id FROM push_batches WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM rain_events e WHERE e.batch_id=push_batches.id) AND NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.batch_id=push_batches.id) LIMIT 100)",
    )
    .bind(new Date(now.getTime() - 30 * 86400000).toISOString())
    .run();
  return stats;
}
