import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRainTransition, type RainState } from "../src/push/transition";
import { checkAndRecordRainState } from "../src/push/rain";
import { drainRainOutbox } from "../src/push/outbox";
import { sendPushNotificationToOne } from "../src/push/send";
import { TestD1 } from "./helpers/sqlite";
vi.mock("../src/push/send", () => ({
  sendPushNotificationToOne: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(() => vi.clearAllMocks());
const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 10, 12, minute)).toISOString();
const sample = (minute: number, rate: number | null, id = "loc-1") => ({
  stationId: id,
  stationName: id,
  observedAt: at(minute),
  rainRateMmH: rate,
});
const vapid = {
  subject: "mailto:test@example.com",
  publicKey: "test",
  privateKey: "test",
};
function sequence(values: Array<[number, number | null]>) {
  let state: RainState | null = null;
  let count = 0;
  for (const [minute, rate] of values) {
    const next = evaluateRainTransition(
      state,
      sample(minute, rate),
      Date.parse(at(minute)),
    );
    state = next.state;
    count += Number(next.event);
  }
  return { state, count };
}
describe("rain reducer contract", () => {
  it.each([0, 0.1, 10])("bootstraps silently at %s", (rate) =>
    expect(sequence([[0, rate]]).count).toBe(0),
  );
  it("threshold and continuous rain", () =>
    expect(
      sequence([
        [0, 0],
        [5, 0.09],
        [10, 0.1],
        [15, 4],
      ]).count,
    ).toBe(1));
  it("null and a single dry sample never rearm", () =>
    expect(
      sequence([
        [0, 0],
        [5, 1],
        [10, null],
        [15, 1],
        [20, 0],
        [25, 1],
      ]).count,
    ).toBe(1));
  it("requires two distinct dry observations spanning 5 minutes", () =>
    expect(
      sequence([
        [0, 0],
        [5, 1],
        [10, 0],
        [10, 0],
        [12, 0],
        [15, 0],
        [20, 1],
      ]).count,
    ).toBe(2));
  it("invalid rates interrupt dry confirmation", () =>
    expect(
      sequence([
        [0, 0],
        [5, 1],
        [10, 0],
        [12, NaN],
        [15, 0],
        [20, 1],
      ]).count,
    ).toBe(1));
  it.each([-1, NaN, Infinity])("rejects invalid rate %s", (rate) =>
    expect(
      sequence([
        [0, 0],
        [5, rate],
      ]).count,
    ).toBe(0),
  );
  it("silently rebaselines after gap", () =>
    expect(
      sequence([
        [0, 0],
        [20, 2],
        [25, 3],
      ]).count,
    ).toBe(0));
  it("does not regress or count duplicate timestamps", () => {
    const { state, count } = sequence([
      [0, 0],
      [5, 1],
      [4, 0],
      [5, 0],
    ]);
    expect(count).toBe(1);
    expect(state?.raining).toBe(1);
  });
  it("freshness and future boundaries use milliseconds", () => {
    for (const [age, valid] of [
      [900000, true],
      [900001, false],
      [-120000, true],
      [-120001, false],
    ] as const) {
      const r = evaluateRainTransition(
        null,
        sample(0, 0),
        Date.parse(at(0)) + age,
      );
      expect(r.state !== null).toBe(valid);
    }
  });
  it("migration state with missing timestamps never emits", () => {
    const p = { raining: 0, version: 0 } as RainState;
    expect(
      evaluateRainTransition(p, sample(0, 2), Date.parse(at(0))).event,
    ).toBe(false);
  });
});
describe("SQLite event and delivery transactions", () => {
  async function event(db: TestD1, ids = ["loc-1"]) {
    for (const id of ids) db.latest(id, at(5), 1);
    await checkAndRecordRainState(
      db.db,
      at(0),
      ids.map((id) => sample(0, 0, id)),
    );
    await checkAndRecordRainState(
      db.db,
      at(5),
      ids.map((id) => sample(5, 1, id)),
    );
  }
  it("persists one event under interleaved evaluations", async () => {
    const db = new TestD1();
    await checkAndRecordRainState(db.db, at(0), [sample(0, 0)]); // serialize batch while allowing stale reads
    const original = db.batch.bind(db);
    let chain = Promise.resolve<any>(null);
    db.batch = (s: any[]) => {
      const result = chain.then(() => original(s));
      chain = result.catch(() => null);
      return result;
    };
    await Promise.all([
      checkAndRecordRainState(db.db, at(5), [sample(5, 1)]),
      checkAndRecordRainState(db.db, at(5), [sample(5, 1)]),
    ]);
    expect(db.rows("rain_events")).toHaveLength(1);
  });
  it("rolls back state if event insertion fails", async () => {
    const db = new TestD1();
    await checkAndRecordRainState(db.db, at(0), [sample(0, 0)]);
    db.failBatch = true;
    await expect(
      checkAndRecordRainState(db.db, at(5), [sample(5, 1)]),
    ).rejects.toThrow();
    expect(db.rows("weather_alert_state")[0].raining).toBe(0);
    expect(db.rows("rain_events")).toHaveLength(0);
    db.failBatch = false;
    await checkAndRecordRainState(db.db, at(5), [sample(5, 1)]);
    expect(db.rows("rain_events")).toHaveLength(1);
  });
  it("recovers fanout and groups only selected stations", async () => {
    const db = new TestD1();
    db.subscriber("selected", {
      stationScope: "selected",
      stationIds: ["loc-1"],
      rainStart: true,
      locale: "pt-BR",
    });
    db.subscriber("all");
    await event(db, ["loc-1", "loc-2"]);
    await drainRainOutbox(db.db, vapid, new Date(at(5)));
    expect(sendPushNotificationToOne).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(sendPushNotificationToOne).mock.calls;
    const selected = calls.find((c) => c[1].endpoint.endsWith("selected"))!;
    expect(selected[2].body).not.toContain("loc-2");
    expect(
      db.rows("push_deliveries").every((d: any) => d.status === "accepted"),
    ).toBe(true);
    await drainRainOutbox(db.db, vapid, new Date(at(6)));
    expect(sendPushNotificationToOne).toHaveBeenCalledTimes(2);
  });
  it("retries provider failures then accepts without a new event", async () => {
    const db = new TestD1();
    db.subscriber();
    await event(db);
    vi.mocked(sendPushNotificationToOne).mockRejectedValueOnce({
      statusCode: 503,
    });
    await drainRainOutbox(db.db, vapid, new Date(at(5)));
    expect(db.rows("push_deliveries")[0].status).toBe("retry");
    await drainRainOutbox(db.db, vapid, new Date(at(10)));
    expect(db.rows("push_deliveries")[0].status).toBe("accepted");
  });
  it.each([400, 401, 403])(
    "permanent provider %s preserves subscriptions",
    async (code) => {
      const db = new TestD1();
      db.subscriber();
      await event(db);
      vi.mocked(sendPushNotificationToOne).mockRejectedValueOnce({
        statusCode: code,
      });
      await drainRainOutbox(db.db, vapid, new Date(at(5)));
      expect(db.rows("push_subscriptions")).toHaveLength(1);
      expect(db.rows("push_deliveries")[0].status).toBe("permanent-failure");
    },
  );
  it.each([404, 410])("removes expired subscriptions (%s)", async (code) => {
    const db = new TestD1();
    db.subscriber();
    await event(db);
    vi.mocked(sendPushNotificationToOne).mockRejectedValueOnce({
      statusCode: code,
    });
    await drainRainOutbox(db.db, vapid, new Date(at(5)));
    expect(db.rows("push_subscriptions")).toHaveLength(0);
  });
  it("does not send expired, dry, removed-preference or shadow events", async () => {
    for (const mode of ["expired", "dry", "preference", "shadow"]) {
      const db = new TestD1();
      db.subscriber();
      await event(db);
      if (mode === "dry") db.latest("loc-1", at(6), 0);
      if (mode === "preference")
        db.raw.exec("UPDATE push_subscriptions SET preferences='{}'");
      if (mode === "shadow")
        db.raw.exec("UPDATE push_batches SET mode='shadow'");
      await drainRainOutbox(
        db.db,
        vapid,
        new Date(at(mode === "expired" ? 21 : 6)),
      );
    }
    expect(sendPushNotificationToOne).not.toHaveBeenCalled();
  });
  it("preserves legacy records during upgrade", () => {
    const db = new TestD1(false);
    db.raw.exec(
      "INSERT INTO push_subscriptions(endpoint,p256dh,auth) VALUES ('https://fcm.googleapis.com/old','k','a');INSERT INTO weather_alert_state(station_id,raining) VALUES ('loc-1',0)",
    );
    db.migrate();
    expect(db.rows("push_subscriptions")[0].id).toBeTruthy();
    expect(
      JSON.parse(db.rows("push_subscriptions")[0].preferences).rainForecast,
    ).toBe(true);
    expect(db.rows("weather_alert_state")[0].last_valid_observed_at).toBeNull();
  });
  it("indexes delivery scheduling and event lookup", () => {
    const db = new TestD1();
    expect(
      JSON.stringify(
        db.raw
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM push_deliveries WHERE status='pending' AND next_attempt_at<'x'",
          )
          .all(),
      ),
    ).toContain("push_delivery_due");
    expect(
      JSON.stringify(
        db.raw
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM rain_events WHERE batch_id='x'",
          )
          .all(),
      ),
    ).toContain("rain_event_batch");
  });
});

it("fanout resumes across pages without duplicate deliveries or late subscribers", async () => {
  const db = new TestD1();
  for (let i = 0; i < 105; i++)
    db.subscriber("sub-" + String(i).padStart(3, "0"));
  db.latest("loc-1", at(5), 1);
  await checkAndRecordRainState(db.db, at(0), [sample(0, 0)]);
  await checkAndRecordRainState(db.db, at(5), [sample(5, 1)]);
  db.subscriber("late");
  db.raw
    .prepare("UPDATE push_subscriptions SET created_at=? WHERE id=?")
    .run(at(6), "late");
  for (let i = 0; i < 3; i++)
    await drainRainOutbox(db.db, vapid, new Date(at(6)));
  expect(db.rows("push_deliveries")).toHaveLength(105);
  expect(
    db.rows("push_deliveries").every((d: any) => d.status === "accepted"),
  ).toBe(true);
  expect(sendPushNotificationToOne).toHaveBeenCalledTimes(105);
});
it("active lease prevents a duplicate sender and expired lease recovers", async () => {
  const db = new TestD1();
  db.subscriber();
  db.latest("loc-1", at(5), 1);
  await checkAndRecordRainState(db.db, at(0), [sample(0, 0)]);
  await checkAndRecordRainState(db.db, at(5), [sample(5, 1)]);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(sendPushNotificationToOne).mockReturnValueOnce(blocked);
  const first = drainRainOutbox(db.db, vapid, new Date(at(5)));
  await vi.waitFor(() =>
    expect(sendPushNotificationToOne).toHaveBeenCalledTimes(1),
  );
  await drainRainOutbox(db.db, vapid, new Date(at(6)));
  expect(sendPushNotificationToOne).toHaveBeenCalledTimes(1);
  release();
  await first;
  db.raw.exec(
    "UPDATE push_deliveries SET status='sending',attempt_count=1,lease_until='2026-11-10T12:06:00.000Z'",
  );
  await drainRainOutbox(db.db, vapid, new Date(at(7)));
  expect(sendPushNotificationToOne).toHaveBeenCalledTimes(2);
});
