import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePushApi, validEndpoint } from "../src/push/api";
import { TestD1 } from "./helpers/sqlite";
import { sendPushNotificationToOne } from "../src/push/send";
vi.mock("../src/push/send", () => ({
  sendPushNotificationToOne: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(() => vi.clearAllMocks());
const token = "a".repeat(43),
  endpoint = "https://fcm.googleapis.com/device";
const keys = {
  p256dh: btoa(
    String.fromCharCode(4) + String.fromCharCode(...new Uint8Array(64)),
  ),
  auth: btoa(String.fromCharCode(...new Uint8Array(16))),
};
const prefs = {
  stationScope: "selected",
  stationIds: ["loc-1"],
  rainStart: true,
  rainForecast: false,
  temperatureForecast: false,
  locale: "pt-BR",
};
function call(
  db: TestD1,
  path: string,
  body: object,
  auth?: string,
  origin = "https://meteo.test",
) {
  return handlePushApi(
    new Request("https://meteo.test" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(auth ? { authorization: "Bearer " + auth } : {}),
      },
      body: JSON.stringify(body),
    }),
    { DB: db.db, VAPID_PUBLIC_KEY: "key", VAPID_PRIVATE_KEY: "private" },
  );
}
async function subscribe(db: TestD1) {
  db.location();
  return call(db, "/api/push-subscribe", {
    version: 2,
    endpoint,
    keys,
    controlToken: token,
    preferences: prefs,
  });
}
describe("push v2 API with SQLite", () => {
  it("idempotent registration hashes credential and preserves identity", async () => {
    const db = new TestD1();
    expect((await subscribe(db))?.status).toBe(200);
    const row = db.rows("push_subscriptions")[0];
    expect(row.control_hash).not.toBe(token);
    expect((await subscribe(db))?.status).toBe(200);
    expect(db.rows("push_subscriptions")).toHaveLength(1);
    expect(db.rows("push_subscriptions")[0].id).toBe(row.id);
  });
  it("protects status/preferences/cancel/test with capability", async () => {
    const db = new TestD1();
    await subscribe(db);
    for (const path of [
      "/api/push/status",
      "/api/push/preferences",
      "/api/push-unsubscribe",
      "/api/push/test-device",
    ])
      expect(
        (await call(db, path, { endpoint, preferences: prefs }, "b".repeat(43)))
          ?.status,
      ).toBe(403);
    expect(db.rows("push_subscriptions")).toHaveLength(1);
  });
  it("returns private status without keys or endpoint", async () => {
    const db = new TestD1();
    await subscribe(db);
    const r = await call(db, "/api/push/status", { endpoint }, token);
    const body = await r!.text();
    expect(body).toContain("rainStart");
    expect(body).not.toContain(endpoint);
    expect(body).not.toContain("control_hash");
    expect(r!.headers.get("cache-control")).toBe("no-store");
  });
  it("legacy promotion requires matching keys and cannot be overwritten", async () => {
    const db = new TestD1();
    db.location();
    await call(db, "/api/push-subscribe", { endpoint, keys });
    const wrong = { ...keys, auth: btoa("x".repeat(16)) };
    expect(
      (
        await call(db, "/api/push-subscribe", {
          version: 2,
          endpoint,
          keys: wrong,
          controlToken: token,
          preferences: prefs,
        })
      )?.status,
    ).toBe(403);
    expect((await subscribe(db))?.status).toBe(200);
    expect(
      (await call(db, "/api/push-subscribe", { endpoint, keys }))?.status,
    ).toBe(409);
  });
  it("cancellation is idempotent", async () => {
    const db = new TestD1();
    await subscribe(db);
    for (let i = 0; i < 2; i++)
      expect(
        (await call(db, "/api/push-unsubscribe", { endpoint }, token))?.status,
      ).toBe(200);
    expect(db.rows("push_subscriptions")).toHaveLength(0);
  });
  it("targeted test only sends once per minute", async () => {
    const db = new TestD1();
    await subscribe(db);
    expect(
      (await call(db, "/api/push/test-device", { endpoint }, token))?.status,
    ).toBe(200);
    expect(
      (await call(db, "/api/push/test-device", { endpoint }, token))?.status,
    ).toBe(429);
    expect(sendPushNotificationToOne).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(sendPushNotificationToOne).mock.calls[0]![1].endpoint,
    ).toBe(endpoint);
  });
  it("rejects foreign origin and invalid selections", async () => {
    const db = new TestD1();
    await subscribe(db);
    expect(
      (
        await call(
          db,
          "/api/push/status",
          { endpoint },
          token,
          "https://evil.test",
        )
      )?.status,
    ).toBe(403);
    for (const stationIds of [[], ["unknown"], ["loc-1", "loc-1"]])
      expect(
        (
          await call(
            db,
            "/api/push/preferences",
            { endpoint, preferences: { ...prefs, stationIds } },
            token,
          )
        )?.status,
      ).toBe(400);
  });
  it.each([
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://user:pass@fcm.googleapis.com/x",
    "https://example.com/x",
  ])("rejects destination %s", (value) =>
    expect(validEndpoint(value)).toBe(false),
  );
  it("supports known Apple, Mozilla and Google endpoints", () => {
    for (const host of [
      "web.push.apple.com",
      "updates.push.services.mozilla.com",
      "fcm.googleapis.com",
    ])
      expect(validEndpoint("https://" + host + "/x")).toBe(true);
  });
});

it("enforces registration budget without exposing IP", async () => {
  const db = new TestD1();
  db.location();
  for (let i = 0; i < 21; i++) {
    const r = await handlePushApi(
      new Request("https://meteo.test/api/push-subscribe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.1",
        },
        body: JSON.stringify({ endpoint, keys }),
      }),
      { DB: db.db },
    );
    expect(r?.status).toBe(i < 20 ? 200 : 429);
  }
  expect(db.rows("push_api_limits")[0].key).not.toContain("192.0.2.1");
});
