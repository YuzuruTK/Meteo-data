# meteo-data

A scalable, configuration-driven meteorological data collector for **Cloudflare Workers + Cron Triggers + D1**.

It runs automatically **every 5 minutes**, reads a JSON configuration of one or more weather APIs, calls every enabled API/location combination, normalizes each response into a common canonical meteorological model, and stores the observations in D1 — including full history, run tracking, and per-request failure logging.

**Adding another API or another location normally requires only editing the JSON configuration — not the Worker source code.**

## How it works

```text
JSON configuration
        |
        v
Load enabled API sources
        |
        v
For each configured location (with bounded concurrency)
        |
        v
Build API request  (secret interpolation, location params)
        |
        v
Fetch API  (with timeout, AbortController)
        |
        v
Validate response / HTTP errors
        |
        v
Select relevant response object  (JSON path)
        |
        v
Normalize fields  (JSON path extraction)
        |
        v
Normalize units  (e.g. F -> C, kW/m2 -> W/m2)
        |
        v
Validate normalized observation (required fields)
        |
        v
Store in D1  (duplicate-safe on source+location+observed_at)
```

The pipeline is fully generic — there is **no** provider-specific branching like `if API === "weather-com"`. Everything the collector needs to know about a source is described in `config/weather-sources.json`.

## Features

- **Every-5-minute Cron trigger** (`*/5 * * * *`).
- **Manual fetch trigger** protected by a secret header (see below).
- **Configuration-driven** — multiple APIs, multiple locations per API.
- **Secret interpolation** — `${WEATHER_COM_API_KEY}` etc. resolved from Worker bindings; never committed.
- **Generic JSON path extraction** (no heavy dependency).
- **Unit normalization** — temperature (C/F/K → °C), solar radiation (W/m² / kW/m² → W/m²), and more.
- **Canonical observation model** with nullable secondary fields.
- **Historical storage** — every successful collection inserts a row.
- **Duplicate protection** — `UNIQUE(source_id, location_id, observed_at)` + `INSERT OR IGNORE`.
- **Failure isolation** — a failed API/location does not abort the rest.
- **Controlled concurrency** (default 3).
- **Run tracking** (`collector_runs`) and **per-request logging** (`collector_requests`), with no secrets logged.
- **Anonymous rain-alert push notifications** — browser Web Push when rain starts, no accounts, with stale-subscription cleanup (see [docs/PUSH-NOTIFICATIONS.md](docs/PUSH-NOTIFICATIONS.md)).

## Project layout

```text
migrations/0001_initial_schema.sql   D1 schema
src/
  worker.ts                          scheduled + protected fetch handlers
  config/config.ts                   config loading/validation
  config/weather-sources.json        weather source definitions
  collector/
    types.ts                         TS types
    json-path.ts                     tiny JSONPath evaluator
    units.ts                         unit conversion
    request.ts                       generic request builder
    normalize.ts                     response -> canonical observation
    validate.ts                      config validation
    collector.ts                     orchestration (concurrency, isolation, persistence)
  db/
    types.ts                         Env bindings
    locations.ts                     weather_locations persistence
    observations.ts                  weather_observations persistence
    runs.ts                          collector_runs / collector_requests persistence
  push/
    api.ts                           subscribe/unsubscribe/public-key handlers
    subscriptions.ts                 push_subscriptions persistence
    send.ts                          web-push delivery + 404/410 cleanup
    rain.ts                          dry->wet rain detection + messages
    alerts.ts                        rain-alert orchestration
    vapid.ts                         key helpers
tests/                               vitest test suite (41 tests)
docs/                                how-to guides
```

## Getting started

See:

- [docs/SECRETS.md](docs/SECRETS.md) — configure Cloudflare secrets.
- [docs/MIGRATIONS.md](docs/MIGRATIONS.md) — apply the D1 migration.
- [docs/RUNNING-LOCALLY.md](docs/RUNNING-LOCALLY.md) — run the Worker locally.
- [docs/ADDING-AN-API.md](docs/ADDING-AN-API.md) — add a new weather source.
- [docs/ADDING-A-LOCATION.md](docs/ADDING-A-LOCATION.md) — add a location to an existing source.
- [docs/PUSH-NOTIFICATIONS.md](docs/PUSH-NOTIFICATIONS.md) — enable anonymous rain-alert push notifications.

## Dashboard

A simple web dashboard is served at the Worker's root (`/`). It shows hourly averages per meteorological variable, grouped by station, with a station selector and time-range filter.

- The dashboard is a **Vite + React + Recharts** app in `dashboard/`.
- It reads from two public JSON endpoints:
  - `GET /api/observations/aggregate?hours=N&station=ID` — hourly averages per station.
  - `GET /api/stations?hours=N` — station list for the selector.
- Build the dashboard with `npm run build:dashboard`; `npm run deploy` builds it automatically.
- Run it locally with `npm run dev` (the Worker serves assets from `dashboard/dist`).

```
dashboard/
  index.html
  package.json      Vite + React + Recharts app
  src/App.tsx       dashboard UI (charts + table)
  src/api.ts        fetch helpers for the public API
  src/types.ts      shared dashboard types
  vite.config.ts
```

The aggregation logic lives in `src/dashboard/aggregate.ts` (D1 queries) and `src/dashboard/api.ts` (public JSON handlers), routed from `src/worker.ts`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run locally with `wrangler dev` |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run build` | Dry-run build (bundle check) |
| `npm run typecheck` | TypeScript type check |
| `npm test` | Run the test suite |
| `npm run migrate:local` | Apply migrations to the local D1 DB |
| `npm run migrate:remote` | Apply migrations to the remote D1 DB |

## Manual trigger

The Worker also exposes a `POST` endpoint to trigger a collection on demand:

```bash
curl -X POST https://YOUR_WORKER.workers.dev/ \
  -H "x-collector-trigger: YOUR_TRIGGER_SECRET"
```

If `COLLECTOR_TRIGGER_SECRET` is not set, the endpoint returns `403 Forbidden` and is effectively disabled.