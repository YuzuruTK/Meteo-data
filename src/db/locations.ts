import type { D1Database } from "@cloudflare/workers-types";

export interface LocationRow {
  id: string;
  source_id: string;
  external_id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  updated_at: string;
}

/** Result of an upsert operation. */
export interface UpsertLocationResult {
  /** id of the inserted or existing row. */
  id: string;
  created: boolean;
}

/**
 * Insert a location if it does not exist, or update metadata if it changed.
 * Uses the (source_id, external_id) unique key.
 *
 * The `external_id` is the source-specific identifier (e.g. stationId). The
 * `location_id` is the config-level identifier used in observations.
 */
export async function upsertLocation(
  db: D1Database,
  input: {
    id: string;
    sourceId: string;
    externalId: string;
    name: string;
    latitude?: number | null;
    longitude?: number | null;
    now: string;
  },
): Promise<UpsertLocationResult> {
  const now = input.now;

  // Try insert first; on unique conflict, update.
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO weather_locations
        (id, source_id, external_id, name, latitude, longitude, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.sourceId,
      input.externalId,
      input.name,
      input.latitude ?? null,
      input.longitude ?? null,
      now,
      now,
    )
    .run();

  // If a row was inserted, we're done.
  const changes = insert.meta.changes;
  if (changes > 0) {
    return { id: input.id, created: true };
  }

  // Otherwise update existing row (preserve created_at).
  const existing = await db
    .prepare(
      `SELECT latitude, longitude FROM weather_locations
       WHERE source_id = ? AND external_id = ?`,
    )
    .bind(input.sourceId, input.externalId)
    .first<{ latitude: number | null; longitude: number | null }>();

  // Enrich with API-provided coords only when the config did not provide them,
  // to avoid overwriting explicitly configured metadata.
  const lat = input.latitude ?? existing?.latitude ?? null;
  const lon = input.longitude ?? existing?.longitude ?? null;

  await db
    .prepare(
      `UPDATE weather_locations
       SET name = ?, latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude), updated_at = ?
       WHERE source_id = ? AND external_id = ?`,
    )
    .bind(input.name, lat, lon, now, input.sourceId, input.externalId)
    .run();

  return { id: input.id, created: false };
}

/**
 * Resolve the DB id for a (source_id, external_id) pair, used to link
 * observations to the canonical location row.
 */
export async function getLocationIdByExternal(
  db: D1Database,
  sourceId: string,
  externalId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM weather_locations WHERE source_id = ? AND external_id = ?`,
    )
    .bind(sourceId, externalId)
    .first<{ id: string }>();
  return row?.id ?? null;
}