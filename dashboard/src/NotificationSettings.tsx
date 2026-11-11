import { useEffect, useState } from "react";
import {
  getExistingSubscription,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  subscriptionStatus,
  savePreferences,
  testDevice,
  type PushPreferences,
} from "./push";
import { useMessages, type MessageKey } from "./messages";
import type { Station } from "./types";
export default function NotificationSettings({
  stations,
  selected,
}: {
  stations: Station[];
  selected: string;
}) {
  const { locale, t } = useMessages();
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<
    | "checking"
    | "new"
    | "active"
    | "pending"
    | "paused"
    | "legacy"
    | "cancel-pending"
  >("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [notice, setNotice] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [preferences, setPreferences] = useState<PushPreferences>({
    stationScope: selected ? "selected" : "all",
    stationIds: selected ? [selected] : [],
    rainStart: true,
    rainForecast: false,
    temperatureForecast: false,
    locale,
  });
  const supported = isPushSupported();
  const secure = window.isSecureContext;
  const [permission, setPermission] = useState(
    supported ? Notification.permission : "default",
  );
  useEffect(() => {
    let current = true;
    const check = async () => {
      if (!supported || !secure) {
        setState("new");
        return;
      }
      setPermission(Notification.permission);
      try {
        const sub = await getExistingSubscription();
        if (!current) return;
        if (!sub) {
          setState("new");
          return;
        }
        try {
          const status = await subscriptionStatus(sub);
          if (current) {
            setPreferences(status.preferences);
            setState(
              status.legacy
                ? "legacy"
                : status.paused
                  ? "paused"
                  : Notification.permission === "granted"
                    ? "active"
                    : "pending",
            );
          }
        } catch {
          if (current) setState("pending");
        }
      } catch {
        if (current) setState("pending");
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      current = false;
      window.removeEventListener("focus", check);
    };
  }, [supported, secure]);
  const active = state === "active" || state === "paused";
  const empty =
    preferences.rainStart &&
    preferences.stationScope === "selected" &&
    !preferences.stationIds.length;
  const perform = async (action: "save" | "cancel" | "test") => {
    setBusy(true);
    setError(null);
    setNotice(false);
    try {
      if (action === "cancel") {
        setState("cancel-pending");
        await unsubscribeFromPush();
        setState("new");
      } else if (action === "test") {
        await testDevice();
        setNotice(true);
        setCooldown(Date.now() + 60000);
      } else {
        const p = { ...preferences, locale };
        const result = active
          ? await savePreferences(p)
          : await subscribeToPush(p);
        setPreferences(p);
        setState(result.paused ? "paused" : "active");
      }
    } catch (e) {
      setError(
        e instanceof Error && e.message === "push-403"
          ? "tokenLost"
          : "pushError",
      );
      if (action === "cancel") setState("cancel-pending");
      else if (!active) setState("pending");
    } finally {
      setBusy(false);
      if (supported) setPermission(Notification.permission);
    }
  };
  return (
    <section className="card notifications" aria-labelledby="alerts-title">
      <div className="section-title">
        <div>
          <div className="eyebrow">Web Push</div>
          <h2 id="alerts-title">{t("alerts")}</h2>
          <p className="muted">{t("benefit")}</p>
        </div>
        <button
          onClick={() => {
            if (!expanded && state === "new")
              setPreferences((p) => ({
                ...p,
                stationScope: selected ? "selected" : "all",
                stationIds: selected ? [selected] : [],
              }));
            setExpanded(!expanded);
          }}
          aria-expanded={expanded}
          aria-controls="alert-settings"
        >
          {t("configure")}
        </button>
      </div>
      <p role="status">
        {state === "checking"
          ? t("loading")
          : state === "cancel-pending"
            ? t("cancelPending")
            : state === "pending"
              ? t("pending")
              : state === "legacy"
                ? t("legacy")
                : active
                  ? t(
                      state === "paused" ||
                        (!preferences.rainStart &&
                          !preferences.rainForecast &&
                          !preferences.temperatureForecast)
                        ? "paused"
                        : "active",
                    )
                  : ""}
      </p>
      {!secure ? (
        <p>{t("insecure")}</p>
      ) : !supported ? (
        <p>{t("unsupported")}</p>
      ) : permission === "denied" ? (
        <p>{t("denied")}</p>
      ) : null}
      {expanded && (
        <div id="alert-settings">
          <fieldset
            disabled={busy || !supported || !secure || state === "checking"}
          >
            <legend>{t("station")}</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={preferences.stationScope === "all"}
                onChange={(e) =>
                  setPreferences({
                    ...preferences,
                    stationScope: e.target.checked ? "all" : "selected",
                  })
                }
              />
              {t("all")}
            </label>
            <div className="station-choices">
              {stations.map((s) => (
                <label className="check" key={s.id}>
                  <input
                    type="checkbox"
                    disabled={preferences.stationScope === "all"}
                    checked={
                      preferences.stationScope === "all" ||
                      preferences.stationIds.includes(s.id)
                    }
                    onChange={(e) =>
                      setPreferences({
                        ...preferences,
                        stationIds: e.target.checked
                          ? [...preferences.stationIds, s.id]
                          : preferences.stationIds.filter((id) => id !== s.id),
                      })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
            {(
              ["rainStart", "rainForecast", "temperatureForecast"] as const
            ).map((key) => (
              <label className="check" key={key}>
                <input
                  type="checkbox"
                  checked={preferences[key]}
                  onChange={(e) =>
                    setPreferences({ ...preferences, [key]: e.target.checked })
                  }
                />
                {t(key)}
              </label>
            ))}
            {empty && <p>{t("selectOne")}</p>}
            <div className="actions">
              <button
                disabled={empty || permission === "denied"}
                onClick={() => void perform("save")}
              >
                {busy ? t("loading") : t(active ? "save" : "activate")}
              </button>
              {(active ||
                state === "pending" ||
                state === "cancel-pending") && (
                <button
                  className="secondary"
                  onClick={() => void perform("cancel")}
                >
                  {t("cancel")}
                </button>
              )}
              {active && (
                <button
                  className="secondary"
                  disabled={state === "paused" || Date.now() < cooldown}
                  onClick={() => void perform("test")}
                >
                  {t("test")}
                </button>
              )}
            </div>
          </fieldset>
        </div>
      )}
      {error && <p role="alert">{t(error)}</p>}
      {notice && <p role="status">{t("accepted")}</p>}
      <p className="notification-hint">{t("latency")}</p>
    </section>
  );
}
