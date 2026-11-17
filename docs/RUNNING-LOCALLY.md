# Running the Worker locally

## Prerequisites

- Node.js 20+ and npm.
- (Optional) a D1 database created in your Cloudflare account.

## 1. Install dependencies

```bash
npm install
```

## 2. Set up local secrets

Create a `.dev.vars` file (git-ignored) in the project root:

```text
WEATHER_COM_API_KEY=your-api-key
COLLECTOR_TRIGGER_SECRET=some-token

# Optional: enable rain-alert push notifications
# Generate keys with: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=<your-vapid-public-key>
VAPID_PRIVATE_KEY=<your-vapid-private-key>
VAPID_SUBJECT=mailto:you@example.com
```

## 3. Configure D1

Create the database (once):

```bash
npx wrangler d1 create meteo-data
```

Put the returned `database_id` into `wrangler.jsonc` under `d1_databases[0].database_id` (replacing `REPLACE_WITH_DATABASE_ID`).

Apply the migration to the local DB:

```bash
npm run migrate:local
```

## 4. Start the dev server

```bash
npm run dev
```

This starts `wrangler dev`, which:
- serves the Worker at `http://localhost:8787`
- runs the local D1 instance (persisted under `.wrangler/state`)
- reads `.dev.vars` for secrets
- registers the cron trigger

## 5. Trigger a collection manually

Cron triggers run on the real schedule, but you can trigger a scheduled-like run locally:

```bash
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

Or use the protected fetch endpoint you configured:

```bash
curl -X POST http://localhost:8787/ \
  -H "x-collector-trigger: some-token"
```

## 6. Inspect the data

Local D1 data is stored under `.wrangler/state/v3/d1/<database-id>.sqlite`. Inspect it with `sqlite3` or a SQLite GUI:

```bash
sqlite3 .wrangler/state/v3/d1/<database-id>.sqlite ".tables"
sqlite3 .wrangler/state/v3/d1/<database-id>.sqlite "SELECT * FROM weather_observations ORDER BY collected_at DESC LIMIT 10;"
```

## Run locally with a production-data example

To use a copy of production data without changing your normal local D1:

```bash
npm run dev:example
```

The local-only script first checks `.wrangler/production-example/production-example.sql`.
If the dump is less than 60 minutes old, it reuses it without exporting again or
overwriting it. Otherwise, it exports a fresh SQL snapshot from the remote
`meteo-data` D1 and imports it into a separate local persistence directory at
`.wrangler/production-example/state`. The example worker uses that same directory.
Stop the example worker before running `npm run db:example` manually to refresh it.

The snapshot includes weather locations, raw observations, and the dashboard's
materialized summary/rollup tables. It excludes push subscriptions and collector
run/request logs and alert state. The omitted operational tables are created empty
locally so application routes can still be exercised. These files are under
`.wrangler/` and are ignored by Git.

The remote export runs at most once per hour when you use this command, but it
still scans the selected production tables and may count toward D1 usage. Cloudflare
also documents that a running export blocks other requests to that database, so
prefer running it outside peak usage. The local Worker serves the copied data;
avoid manually triggering collection if you only want to explore the snapshot.

## Notes

- The scheduled handler awaits the collection directly so Cloudflare can track completion and surface failures.
- Logs are concise: a summary per run, plus per-request store/failure lines. No secrets are ever logged.