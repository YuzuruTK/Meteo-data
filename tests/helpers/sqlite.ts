import type { D1Database } from "@cloudflare/workers-types";
const sqlite = await import("node:" + "sqlite");
/** Real SQLite, including rollback semantics of D1 batch. Fails rather than skips without SQLite. */
export class TestD1 {
  raw: any;
  failBatch = false;
  constructor(upgrade = true) {
    this.raw = new sqlite.DatabaseSync(":memory:");
    const files = (import.meta as any).glob("../../migrations/*.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    for (const name of Object.keys(files).sort()) {
      if (!upgrade && /001[01]/.test(name)) continue;
      this.raw.exec(files[name]);
    }
  }
  migrate() {
    const files = (import.meta as any).glob("../../migrations/001*.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    for (const text of Object.values(files)) this.raw.exec(text);
  }
  prepare(sql: string) {
    const stmt = this.raw.prepare(sql);
    const wrap = (args: unknown[]): any => ({
      bind: (...next: unknown[]) => wrap(next),
      run: async () => ({
        meta: { changes: Number(stmt.run(...args).changes) },
      }),
      first: async () => stmt.get(...args) ?? null,
      all: async () => ({ results: stmt.all(...args) }),
    });
    return wrap([]);
  }
  async batch(statements: any[]) {
    this.raw.exec("BEGIN");
    try {
      const result = [];
      for (let i = 0; i < statements.length; i++) {
        if (this.failBatch && i === 2) throw new Error("injected SQL failure");
        result.push(await statements[i].run());
      }
      this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  get db() {
    return this as unknown as D1Database;
  }
  location(id = "loc-1", name = "Ijuí") {
    this.raw
      .prepare(
        "INSERT OR IGNORE INTO weather_locations(id,source_id,external_id,name,created_at,updated_at) VALUES (?,'test',?,?,?,?)",
      )
      .run(id, id, name, "2026-01-01", "2026-01-01");
  }
  latest(id: string, time: string, rate: number | null) {
    this.location(id);
    this.raw
      .prepare(
        "INSERT OR REPLACE INTO latest_weather_observations(location_id,observed_at,precipitation_rate,updated_at) VALUES (?,?,?,?)",
      )
      .run(id, time, rate, time);
  }
  subscriber(id = "sub-1", preferences?: object) {
    this.raw
      .prepare(
        "INSERT INTO push_subscriptions(endpoint,p256dh,auth,id,created_at) VALUES (?,'A','B',?,'2026-01-01')",
      )
      .run("https://fcm.googleapis.com/" + id, id);
    if (preferences)
      this.raw
        .prepare("UPDATE push_subscriptions SET preferences=? WHERE id=?")
        .run(JSON.stringify(preferences), id);
  }
  rows(table: string) {
    return this.raw.prepare(`SELECT * FROM ${table}`).all();
  }
}
