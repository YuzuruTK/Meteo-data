import type { D1Database } from "@cloudflare/workers-types";
import { checkAndRecordRainState } from "./rain";
import { drainRainOutbox } from "./outbox";
import type { PushSendOptions } from "./send";

export interface AlertSendingContext {
  db: D1Database;
  mode?: string;
  /** VAPID keys from the environment. */
  vapid: { subject: string; publicKey: string; privateKey: string };
  /** Stations with current rain rate; used to detect rain starts. */
  stations: Array<{
    stationId: string;
    stationName: string;
    observedAt?: string;
    rainRateMmH: number | null;
  }>;
}

export interface AlertResult {
  stationsUpdated: number;
  alertsFired: number;
  notificationsSent: number;
  notificationsRemoved: number;
  errors: Array<{
    endpoint: string;
    statusCode: number | undefined;
    error: string;
  }>;
}

/**
 * Run the full rain-alert pipeline for a collection cycle:
 *   1. Detect stations that just started raining (dry -> wet).
 *   2. Drain durable deliveries, applying each device's current preferences.
 *
 * This is called after the scheduled/manual collection persists new
 * observations. It is safe to call repeatedly: rain that continues is not
 * re-alerted.
 */
export async function runRainAlerts(
  ctx: AlertSendingContext,
): Promise<AlertResult> {
  let state = { updated: 0, alerts: [] as Array<unknown> };
  try {
    state = await checkAndRecordRainState(
      ctx.db,
      new Date().toISOString(),
      ctx.stations,
      ctx.mode,
    );
  } catch {
    console.error("[rain] evaluation failed; draining existing deliveries");
  }
  const delivery =
    ctx.mode === "shadow"
      ? { sent: 0, removed: 0, errors: [] }
      : await drainRainOutbox(ctx.db, ctx.vapid);
  return {
    stationsUpdated: state.updated,
    alertsFired: state.alerts.length,
    notificationsSent: delivery.sent,
    notificationsRemoved: delivery.removed,
    errors: delivery.errors,
  };
}

/** Helper to build PushSendOptions from raw env values. */
export function buildPushSendOptions(env: {
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}): PushSendOptions | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return null;
  }
  return {
    subject: env.VAPID_SUBJECT ?? "mailto:admin@meteo-data.workers.dev",
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
}
