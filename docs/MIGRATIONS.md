# Applying the D1 migration

The D1 schema lives in `migrations/` and is managed via Wrangler's migration tracking. The initial migration is `0001_initial_schema.sql`, which creates four tables plus indexes:

- `weather_locations`
- `weather_observations`
- `collector_runs`
- `collector_requests`

## Before you begin

1. Create the D1 database (once) if it doesn't already exist:

   ```bash
   npx wrangler d1 create meteo-data
   ```

   Copy the returned `database_id` (UUID) into `wrangler.jsonc` under `d1_databases[0].database_id`.

## Apply locally

```bash
npm run migrate:local
```

This applies the migration to the local D1 instance used by `wrangler dev` (`--persist-to=.wrangler/state`).

## Apply to production

```bash
npm run migrate:remote
```

This applies the migration to the remote D1 database.

## Verify

List applied migrations:

```bash
npx wrangler d1 migrations list meteo-data --remote
```

Inspect data locally:

```bash
sqlite3 .wrangler/state/v3/d1/<database-id>.sqlite "SELECT * FROM weather_observations LIMIT 5;"
```

## Adding a future migration

Wrangler tracks applied migrations, so do not modify `0001` after it has been applied. Create a new numbered file instead:

```bash
npx wrangler d1 migrations create meteo-data describe_change
# creates migrations/0002_describe_change.sql
```

## Notes

- Migrations are idempotent-safe because they use `CREATE TABLE IF NOT EXISTS`.
- Do not destroy existing data — only add new tables/columns.