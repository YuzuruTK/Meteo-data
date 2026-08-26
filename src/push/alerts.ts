import type { D1Database } from "@cloudflare/workers-types";
import { checkAndRecordRainState } from "./rain";
import { sendPushNotifications } from "./send";
import type { PushSendOptions } from "./send";

export interface AlertSendingContext {
  db: D1Database;
  /** VAPID keys from the environment. */
  vapid: { subject: string; publicKey: string; privateKey: string };
  /** Stations with current rain rate; used to detect rain starts. */
  stations: Array<{ stationId: string; stationName: string; rainRateMmH: number | null }>;
}

export interface AlertResult {
  stationsUpdated: number;
  alertsFired: number;
  notificationsSent: number;
  notificationsRemoved: number;
  errors: Array<{ endpoint: string; statusCode: number | undefined; error: string }>;
}

/**
 * Run the full rain-alert pipeline for a collection cycle:
 *   1. Detect stations that just started raining (dry -> wet).
 *   2. Send a push notification to all subscribers for each new rain start.
 *
 * This is called after the scheduled/manual collection persists new
 * observations. It is safe to call repeatedly: rain that continues is not
 * re-alerted.
 */
export async function runRainAlerts(
  ctx: AlertSendingContext,
): Promise<AlertResult> {
  const now = new Date().toISOString();
  const state = await checkAndRecordRainState(ctx.db, now, ctx.stations);

  if (state.alerts.length === 0) {
    return {
      stationsUpdated: state.updated,
      alertsFired: 0,
      notificationsSent: 0,
      notificationsRemoved: 0,
      errors: [],
    };
  }

  // Aggregate multiple simultaneous rain starts into a single push
  // notification so subscribers receive one concise alert instead of N
  // separate notifications.
  const result: AlertResult = {
    stationsUpdated: state.updated,
    alertsFired: state.alerts.length,
    notificationsSent: 0,
    notificationsRemoved: 0,
    errors: [],
  };

  if (state.alerts.length === 1) {
    const alert = state.alerts[0]!;
    const delivery = await sendPushNotifications(
      ctx.db,
      {
        subject: ctx.vapid.subject,
        publicKey: ctx.vapid.publicKey,
        privateKey: ctx.vapid.privateKey,
      },
      {
        title: alert.message.title,
        body: alert.message.body,
        data: { stationId: alert.stationId, url: "/" },
      },
    );
    result.notificationsSent += delivery.sent;
    result.notificationsRemoved += delivery.removed;
    result.errors.push(...delivery.errors);
  } else {
    // Multiple stations started raining — send one aggregated notification.
    const names = state.alerts.map((a) => a.stationName).join(", ");
    const delivery = await sendPushNotifications(
      ctx.db,
      {
        subject: ctx.vapid.subject,
        publicKey: ctx.vapid.publicKey,
        privateKey: ctx.vapid.privateKey,
      },
      {
        title: `🌧️ Rain detected in ${state.alerts.length} stations`,
        body: `Rain started in ${names}.`,
        data: { url: "/" },
      },
    );
    result.notificationsSent += delivery.sent;
    result.notificationsRemoved += delivery.removed;
    result.errors.push(...delivery.errors);
  }

  return result;
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