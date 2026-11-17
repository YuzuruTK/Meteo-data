import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncExampleDatabase } from "../scripts/sync-example-db.mjs";

const HOUR_MS = 60 * 60 * 1000;

async function makeTempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "meteo-example-db-"));
  await writeFile(
    path.join(root, "wrangler.jsonc"),
    JSON.stringify({ d1_databases: [{ database_name: "test-meteo" }] }),
  );
  return root;
}

async function createFakeWrangler(args) {
  const command = args[1];
  if (command === "export") {
    const outputIndex = args.indexOf("--output");
    await writeFile(args[outputIndex + 1], "-- exported weather data\n");
    return;
  }

  if (command === "execute") {
    const persistIndex = args.indexOf("--persist-to");
    const statePath = args[persistIndex + 1];
    await mkdir(statePath, { recursive: true });
    await writeFile(path.join(statePath, "example.sqlite"), "local test database");
    return;
  }

  throw new Error(`Unexpected Wrangler command: ${args.join(" ")}`);
}

describe("syncExampleDatabase", () => {
  let root;

  beforeEach(async () => {
    root = await makeTempRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not export or overwrite a snapshot younger than 60 minutes", async () => {
    const dataDir = path.join(root, ".wrangler", "production-example");
    const snapshotPath = path.join(dataDir, "production-example.sql");
    await mkdir(dataDir, { recursive: true });
    await writeFile(snapshotPath, "keep this existing dump\n");

    const now = Date.now();
    await utimes(snapshotPath, now / 1000, (now - 20 * 60 * 1000) / 1000);

    const commands = [];
    const result = await syncExampleDatabase({
      root,
      now,
      run: async (args) => {
        commands.push(args);
        await createFakeWrangler(args);
      },
    });

    expect(result.exportPerformed).toBe(false);
    expect(result.importPerformed).toBe(true);
    expect(commands.map((args) => args[1])).toEqual(["execute"]);
    expect(commands[0]).toContain("--local");
    expect(commands[0]).toContain("--persist-to");
    expect(await readFile(snapshotPath, "utf8")).toBe("keep this existing dump\n");
  });

  it("reuses an already imported fresh snapshot without repeating export or import", async () => {
    const dataDir = path.join(root, ".wrangler", "production-example");
    const snapshotPath = path.join(dataDir, "production-example.sql");
    const stateDir = path.join(dataDir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(snapshotPath, "cached dump\n");
    await writeFile(path.join(stateDir, "example.sqlite"), "loaded");
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("cached dump\n"),
    );
    const importedHash = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await writeFile(path.join(dataDir, "imported-snapshot.sha256"), importedHash);

    const now = Date.now();
    await utimes(snapshotPath, now / 1000, (now - 10 * 60 * 1000) / 1000);
    const commands = [];
    const result = await syncExampleDatabase({
      root,
      now,
      run: async (args) => commands.push(args),
    });

    expect(result.exportPerformed).toBe(false);
    expect(result.importPerformed).toBe(false);
    expect(commands).toEqual([]);
  });

  it("keeps the previous dump intact when refreshing the expired snapshot fails", async () => {
    const dataDir = path.join(root, ".wrangler", "production-example");
    const snapshotPath = path.join(dataDir, "production-example.sql");
    await mkdir(dataDir, { recursive: true });
    await writeFile(snapshotPath, "previous valid dump\n");

    const now = Date.now();
    await utimes(snapshotPath, now / 1000, (now - 2 * HOUR_MS) / 1000);
    const commands = [];

    await expect(syncExampleDatabase({
      root,
      now,
      run: async (args) => {
        commands.push(args);
        throw new Error("simulated export failure");
      },
    })).rejects.toThrow("simulated export failure");

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--remote");
    expect(commands[0]).toContain("--table");
    expect(await readFile(snapshotPath, "utf8")).toBe("previous valid dump\n");
  });

  it("refreshes exactly at 60 minutes and exports only the example tables", async () => {
    const dataDir = path.join(root, ".wrangler", "production-example");
    const snapshotPath = path.join(dataDir, "production-example.sql");
    await mkdir(dataDir, { recursive: true });
    await writeFile(snapshotPath, "old dump\n");

    const now = Date.now();
    await utimes(snapshotPath, now / 1000, (now - HOUR_MS) / 1000);
    const commands = [];
    await syncExampleDatabase({
      root,
      now,
      run: async (args) => {
        commands.push(args);
        await createFakeWrangler(args);
      },
    });

    expect(commands.map((args) => args[1])).toEqual(["export", "execute"]);
    const exportCommand = commands[0];
    expect(exportCommand).toContain("--remote");
    expect(exportCommand).toContain("weather_observations");
    expect(exportCommand).not.toContain("push_subscriptions");
    expect(exportCommand).not.toContain("collector_requests");
    const snapshot = await readFile(snapshotPath, "utf8");
    expect(snapshot).toContain("-- exported weather data");
    expect(snapshot).toContain("CREATE TABLE IF NOT EXISTS push_subscriptions");
    expect(snapshot).toContain("CREATE TABLE IF NOT EXISTS collector_requests");
    expect(snapshot).not.toContain("INSERT INTO push_subscriptions");
    expect(snapshot).not.toContain("INSERT INTO collector_requests");
  });
});