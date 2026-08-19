# Adding a new weather API

Adding another weather source requires **only editing `config/weather-sources.json`** — no source-code changes. The collector reads this configuration and handles every source generically.

## Structure of a source entry

Each entry in the config array is an object:

```json
{
  "id": "unique-source-id",
  "enabled": true,
  "request": {
    "method": "GET",
    "url": "https://...",
    "headers": { "Authorization": "Bearer ${SOME_TOKEN}" },
    "params": { "lat": "-28.38" },
    "location_param": "stationId",
    "timeout_ms": 10000
  },
  "locations": [
    { "id": "loc-a", "name": "Location A", "stationId": "IIJU2" }
  ],
  "normalization": {
    "observation_selector": "$.observations[0]",
    "fields": {
      "observed_at":     { "path": "$.obsTimeUtc" },
      "temperature":     { "path": "$.metric.temp", "unit": "C" },
      "solar_radiation": { "path": "$.solarRadiation", "unit": "W/m2" }
    }
  }
}
```

### `request`

- `method`: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
- `url`: the API endpoint. May contain secret references, e.g. `https://api.example.com/${API_KEY}/weather`.
- `headers`: optional request headers. Values may reference secrets.
- `params`: optional query parameters. Values may reference secrets.
- `body`: optional request body (string or object).
- `location_param`: (optional) the name of a query param whose value is supplied per location (e.g. `stationId`). When set, **every** location must provide that key.
- `timeout_ms`: optional request timeout in ms (default 10000).

> Secrets are written as `${NAME}` and resolved from Worker bindings at request time. Never put real secret values in the JSON.

### `locations`

Each location contains **only location-specific info** (`id`, `name`, `latitude`, `longitude`, plus anything the request needs via `location_param`). URL/params/headers/normalization stay at the source level.

### `normalization`

- `observation_selector`: a JSON path selecting the object to read fields from, e.g. `$.observations[0]`.
- `fields`: maps canonical meteorological fields to JSON paths within the selected object.
  - `path`: JSONPath within the selected object.
  - `unit`: (optional) the source unit. If omitted, the value is assumed to be already in the canonical unit.
  - `convert_to`: (optional) a target unit. Only conversion to the canonical unit is supported (see below).
- `required`: (optional) an array of fields that must be present. Defaults to `["observed_at"]` — so missing/null weather values (e.g. a station without a solar sensor) are stored as `NULL` instead of dropping the whole observation.

## Canonical units

| Field | Canonical unit |
| --- | --- |
| `temperature` | °C |
| `solar_radiation` | W/m² |
| `humidity` | % |
| `pressure` | hPa |
| `wind_speed` / `wind_gust` | km/h |
| `wind_direction` | degrees |
| `precipitation_rate` | mm/h |
| `precipitation_total` | mm |

Supported conversions: temperature `C`/`F`/`K` → `C`; solar radiation `W/m2`/`kW/m2` → `W/m2`. Unsupported conversions produce a clear error and fail only that request.

## Full example (a different hypothetical API)

```json
{
  "id": "new-weather-api",
  "enabled": true,
  "request": {
    "method": "GET",
    "url": "https://new-api.example.com/weather",
    "params": {
      "latitude": "-28.39",
      "longitude": "-53.91",
      "key": "${NEW_API_KEY}"
    }
  },
  "locations": [
    { "id": "ijui", "name": "Ijuí" }
  ],
  "normalization": {
    "observation_selector": "$.data.current",
    "fields": {
      "observed_at":     { "path": "$.timestamp" },
      "temperature":     { "path": "$.temp", "unit": "F", "convert_to": "C" },
      "solar_radiation": { "path": "$.irradiance", "unit": "kW/m2", "convert_to": "W/m2" },
      "humidity":        { "path": "$.humidity", "unit": "%" }
    }
  }
}
```

## Validation

The config is validated at startup. Common validation errors (duplicate ids, invalid method, bad JSONPath, unsupported unit, missing location param) are reported with actionable messages — the Worker fails to load rather than silently misbehaving.

## If an API needs custom behavior

The generic model covers request building (method/url/headers/params/body), location params, JSON path extraction, field normalization, and unit conversion. If an API requires fundamentally different request/response behavior that can't be expressed by the config, add a dedicated adapter behind the same `collectOne` interface — do **not** put provider branches in the main collector.