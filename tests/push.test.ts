import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { checkAndRecordRainState, buildRainMessage, rainBucket } from "../src/push/rain";
import { insertSubscription, removeSubscription, listSubscriptions } from "../src/push/subscriptions";
import { validatePublicKeyFormat, toBase64Url } from "../src/push/vapid";

type Row = Record<string, unknown>;

/** Minimal fake D1 supporting push_subscriptions and weather_alert_state. */
class FakeD1 {
  subscriptions: Row[] = [];
  states = new Map<string, Row>();

  prepare(sql: string) {
    const self = this;
    return {
      bind: (...args: unknown[]) => this.execute(sql, args),
      all: () => this.execute(sql, []).all(),
      first: <T>() => this.execute(sql, []).first<T>(),
      run: () => this.execute(sql, []).run(),
    };
  }

  private execute(sql: string, bindings: unknown[]) {
    const self = this;
    return {
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO push_subscriptions")) {
          const [endpoint, p256dh, auth] = bindings as [string, string, string];
          if (!self.subscriptions.find((s) => s.endpoint === endpoint)) {
            self.subscriptions.push({ endpoint, p256dh, auth });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (sql.includes("DELETE FROM push_subscriptions")) {
          const [endpoint] = bindings as [string];
          const before = self.subscriptions.length;
          self.subscriptions = self.subscriptions.filter((s) => s.endpoint !== endpoint);
          return { meta: { changes: before - self.subscriptions.length } };
        }
        if (sql.includes("ON CONFLICT(station_id)")) {
          const [stationId, raining] = bindings as [string, number];
          self.states.set(String(stationId), { station_id: stationId, raining });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      all: async () => {
        if (sql.includes("FROM push_subscriptions")) {
          return { results: self.subscriptions };
        }
        return { results: [] };
      },
      first: async <T>() => {
        if (sql.includes("FROM weather_alert_state")) {
          const [stationId] = bindings as [string];
          const row = self.states.get(String(stationId));
          return (row as T) ?? null;
        }
        return null as T;
      },
    };
  }
}

describe("rain alert message building", () => {
  it("classifies intensity by precipitation rate", () => {
    expect(rainBucket(0.5)).toBe("light");
    expect(rainBucket(5)).toBe("moderate");
    expect(rainBucket(20)).toBe("heavy");
  });

  it("builds a human-readable message", () => {
    const m = buildRainMessage("Ijuí", 3.2);
    expect(m.title).toContain("Moderate rain");
    expect(m.body).toContain("Ijuí");
  });
});

describe("rain state detection", () => {
  it("alerts only on a dry -> wet transition", async () => {
    const db = new FakeD1();

    const first = await checkAndRecordRainState(db as unknown as D1Database, "2025-01-01T10:00:00Z", [
      { stationId: "loc-1", stationName: "Ijuí", rainRateMmH: 5 },
    ]);
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]?.stationName).toBe("Ijuí");

    const second = await checkAndRecordRainState(db as unknown as D1Database, "2025-01-01T10:05:00Z", [
      { stationId: "loc-1", stationName: "Ijuí", rainRateMmH: 8 },
    ]);
    expect(second.alerts).toHaveLength(0);

    await checkAndRecordRainState(db as unknown as D1Database, "2025-01-01T11:00:00Z", [
      { stationId: "loc-1", stationName: "Ijuí", rainRateMmH: 0 },
    ]);
    const third = await checkAndRecordRainState(db as unknown as D1Database, "2025-01-01T11:05:00Z", [
      { stationId: "loc-1", stationName: "Ijuí", rainRateMmH: 3 },
    ]);
    expect(third.alerts).toHaveLength(1);
  });

  it("does not alert when dry", async () => {
    const db = new FakeD1();
    const result = await checkAndRecordRainState(db as unknown as D1Database, "2025-01-01T10:00:00Z", [
      { stationId: "loc-1", stationName: "Ijuí", rainRateMmH: 0 },
    ]);
    expect(result.alerts).toHaveLength(0);
    expect(result.updated).toBe(1);
  });
});

describe("VAPID public key validation", () => {
  it("accepts a valid 65-byte 0x04 public key", () => {
    // 0x04 + 32-byte X + 32-byte Y
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    const key = toBase64Url(raw);
    expect(validatePublicKeyFormat(key)).toBeNull();
  });

  it("rejects a key that is not 65 bytes", () => {
    const raw = new Uint8Array([1, 2, 3]);
    expect(validatePublicKeyFormat(toBase64Url(raw))).not.toBeNull();
  });

  it("rejects a 65-byte key without the 0x04 prefix", () => {
    const raw = new Uint8Array(65);
    raw[0] = 0x03;
    expect(validatePublicKeyFormat(toBase64Url(raw))).not.toBeNull();
  });

  it("rejects invalid base64url", () => {
    expect(validatePublicKeyFormat("not-a-valid-@-key!")).not.toBeNull();
  });
});

describe("push subscription persistence", () => {
  it("inserts, dedupes, lists, and removes", async () => {
    const db = new FakeD1();
    const sub = { endpoint: "https://push.example/abc", p256dh: "A", auth: "B" };

    await insertSubscription(db as unknown as D1Database, sub);
    await insertSubscription(db as unknown as D1Database, sub);
    expect((await listSubscriptions(db as unknown as D1Database)).length).toBe(1);

    await removeSubscription(db as unknown as D1Database, sub.endpoint);
    expect((await listSubscriptions(db as unknown as D1Database)).length).toBe(0);
  });
});