import { useEffect, useState } from "react";
import {
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  getExistingSubscription,
} from "./push";

type NotificationState = "unsupported" | "checking" | "subscribed" | "not-subscribed";

interface NotificationSettingsProps {
  onError?: (message: string) => void;
}

/**
 * "Rain Alerts" settings section.
 *
 * Shows the browser notification permission status and lets the user enable
 * or disable anonymous web-push rain alerts. No account is required.
 */
export default function NotificationSettings({ onError }: NotificationSettingsProps) {
  const [supported] = useState(() => isPushSupported());
  const [permission, setPermission] = useState<NotificationPermission | "unavailable">(
    typeof Notification !== "undefined" ? Notification.permission : "unavailable",
  );
  const [state, setState] = useState<NotificationState>("checking");
  const [busy, setBusy] = useState(false);

  // On mount, determine whether a subscription already exists.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supported) {
        setState("unsupported");
        return;
      }
      try {
        const sub = await getExistingSubscription();
        if (!cancelled) {
          setState(sub ? "subscribed" : "not-subscribed");
        }
      } catch {
        if (!cancelled) setState("not-subscribed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const handleSubscribe = async () => {
    setBusy(true);
    try {
      await subscribeToPush();
      setPermission(typeof Notification !== "undefined" ? Notification.permission : "unavailable");
      setState("subscribed");
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
      setState("not-subscribed");
    } finally {
      setBusy(false);
    }
  };

  const handleUnsubscribe = async () => {
    setBusy(true);
    try {
      await unsubscribeFromPush();
      setState("not-subscribed");
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <section className="chart-card">
        <h2>🔔 Rain Alerts</h2>
        <p className="notification-hint">
          Push notifications are not supported in this browser.
        </p>
      </section>
    );
  }

  const permissionLabel =
    permission === "granted"
      ? "Allowed"
      : permission === "denied"
        ? "Blocked"
        : permission === "default"
          ? "Ask"
          : "Unavailable";

  return (
    <section className="chart-card notification-card">
      <h2>🔔 Rain Alerts</h2>
      <div className="notification-row">
        <span className="notification-label">Status</span>
        <span className="notification-permission">
          {permission === "granted" ? "✅" : permission === "denied" ? "🚫" : "❔"} {permissionLabel}
        </span>
      </div>
      <div className="notification-row">
        <span className="notification-label">Alerts</span>
        <span className="notification-value">
          {state === "checking"
            ? "Checking…"
            : state === "subscribed"
              ? "✔ Subscribed to rain alerts"
              : "Not subscribed"}
        </span>
      </div>
      <div className="notification-actions">
        {state === "subscribed" ? (
          <button className="notification-btn unsubscribe" onClick={handleUnsubscribe} disabled={busy}>
            Unsubscribe
          </button>
        ) : (
          <button className="notification-btn subscribe" onClick={handleSubscribe} disabled={busy}>
            {state === "checking" ? "Checking…" : "Subscribe"}
          </button>
        )}
      </div>
      <p className="notification-hint">
        You'll get a notification when rain starts at a station. No account needed.
      </p>
    </section>
  );
}