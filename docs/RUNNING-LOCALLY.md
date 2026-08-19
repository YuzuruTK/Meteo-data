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

## Notes

- The scheduled handler awaits the collection directly so Cloudflare can track completion and surface failures.
- Logs are concise: a summary per run, plus per-request store/failure lines. No secrets are ever logged.