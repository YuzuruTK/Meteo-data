#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_TTL_MS = 60 * 60 * 1000;
const TABLES = [
  "weather_locations",
  "weather_observations",
  "weather_observations_hourly",
  "weather_observations_daily",
  "latest_weather_observations",
  "dashboard_summary",
];
const EMPTY_LOCAL_TABLES_SQL = `
-- These application tables are intentionally empty in the local example copy.
CREATE TABLE IF NOT EXISTS collector_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  sources_attempted INTEGER NOT NULL DEFAULT 0,
  requests_attempted INTEGER NOT NULL DEFAULT 0,
  requests_succeeded INTEGER NOT NULL DEFAULT 0,
  requests_failed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS collector_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  response_time_ms INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS weather_alert_state (
  station_id TEXT PRIMARY KEY,
  raining INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS weather_forecast_alert_state (
  alert_type TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  event_time TEXT,
  fingerprint TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

function runWrangler(args, cwd = PROJECT_ROOT) {
  const cliPath = path.join(cwd, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler command failed with exit code ${result.status ?? "unknown"}.`);
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function directoryHasFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await directoryHasFiles(entryPath)) return true;
  }
  return false;
}

function snapshotIsFresh(fileStat, now) {
  const ageMs = now - fileStat.mtimeMs;
  return ageMs >= 0 && ageMs < CACHE_TTL_MS;
}

/**
 * Synchronize the cached production snapshot into an isolated local D1 store.
 * `root`, `now`, and `run` are injectable for safe local tests.
 */
export async function syncExampleDatabase({
  root = PROJECT_ROOT,
  now = Date.now(),
  run = runWrangler,
} = {}) {
  const dataDir = path.join(root, ".wrangler", "production-example");
  const snapshotPath = path.join(dataDir, "production-example.sql");
  const stateDir = path.join(dataDir, "state");
  const markerPath = path.join(dataDir, "imported-snapshot.sha256");
  const databaseConfig = JSON.parse(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  const databaseName = databaseConfig.d1_databases?.[0]?.database_name;
  if (!databaseName) throw new Error("No D1 database_name found in wrangler.jsonc.");

  await mkdir(dataDir, { recursive: true });

  const hasSnapshot = await snapshotExistsAt(snapshotPath);
  let snapshotStat = hasSnapshot ? await stat(snapshotPath) : null;
  let exportPerformed = false;

  if (snapshotStat && snapshotIsFresh(snapshotStat, now)) {
    console.log("Using the cached production snapshot (< 60 minutes); skipping remote export.");
  } else {
    const temporarySnapshotPath = `${snapshotPath}.tmp-${process.pid}`;
    await rm(temporarySnapshotPath, { force: true });
    try {
      console.log("Exporting selected production weather tables to a temporary SQL file...");
      const exportArgs = [
        "d1", "export", databaseName,
        "--remote",
        "--output", temporarySnapshotPath,
        "--skip-confirmation",
      ];
      for (const table of TABLES) exportArgs.push("--table", table);
      await run(exportArgs, root);

      const tempStat = await stat(temporarySnapshotPath);
      if (!tempStat.isFile() || tempStat.size === 0) {
        throw new Error("Wrangler produced an empty or invalid SQL snapshot.");
      }
      await appendFile(temporarySnapshotPath, EMPTY_LOCAL_TABLES_SQL, "utf8");
      // Rename only after a complete successful export; a prior dump survives
      // failures and is never truncated by Wrangler.
      await rename(temporarySnapshotPath, snapshotPath);
      exportPerformed = true;
      snapshotStat = await stat(snapshotPath);
    } finally {
      await rm(temporarySnapshotPath, { force: true });
    }
  }

  if (!snapshotStat) throw new Error("The SQL snapshot is missing after export.");

  const snapshotHash = await hashFile(snapshotPath);
  const importedHash = await readTextFileOrNull(markerPath);
  const stateIsLoaded = await directoryHasFiles(stateDir);
  if (importedHash === snapshotHash && stateIsLoaded) {
    console.log("This snapshot is already loaded in the example D1; skipping local import.");
    return { exportPerformed, importPerformed: false, snapshotPath, stateDir };
  }

  const candidateStateDir = `${stateDir}.import-${process.pid}`;
  await rm(candidateStateDir, { recursive: true, force: true });
  try {
    console.log("Importing the snapshot into the isolated example D1...");
    await run([
      "d1", "execute", databaseName,
      "--local",
      "--persist-to", candidateStateDir,
      "--file", snapshotPath,
      "--yes",
    ], root);

    if (!await directoryHasFiles(candidateStateDir)) {
      throw new Error("Wrangler completed without creating the example D1 state.");
    }
    await replaceImportedStateAt(stateDir, candidateStateDir);

    const markerTempPath = `${markerPath}.tmp-${process.pid}`;
    await writeFile(markerTempPath, `${snapshotHash}\n`, "utf8");
    await rename(markerTempPath, markerPath);
  } finally {
    await rm(candidateStateDir, { recursive: true, force: true });
  }

  console.log(`Example database is ready. Snapshot: ${path.relative(root, snapshotPath)}`);
  return { exportPerformed, importPerformed: true, snapshotPath, stateDir };
}

async function snapshotExistsAt(snapshotPath) {
  try {
    await access(snapshotPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readTextFileOrNull(filePath) {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function replaceImportedStateAt(stateDir, candidateStateDir) {
  const backupStateDir = `${stateDir}.previous-${process.pid}`;
  await rm(backupStateDir, { recursive: true, force: true });

  const hasExistingState = await directoryHasFiles(stateDir);
  if (hasExistingState) await rename(stateDir, backupStateDir);
  else await rm(stateDir, { recursive: true, force: true });

  try {
    await rename(candidateStateDir, stateDir);
  } catch (error) {
    if (hasExistingState) await rename(backupStateDir, stateDir);
    throw error;
  }

  await rm(backupStateDir, { recursive: true, force: true });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    await syncExampleDatabase();
  } catch (error) {
    console.error(`[example-db] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}