# Current-value source fallback

`GET /api/summary` retains its existing `summaries` property and adds an
independent `effective_current` property. The latter resolves values per
coordinate-matched location and per variable from raw observations; the
collector's stored rows are never changed.

## Source policy and freshness

The priority and maximum ages are centralized in
`src/db/effective-current.ts`:

1. `weather-com-pws` — up to 15 minutes old.
2. `open-meteo-current` — up to 30 minutes old.

Age is computed from `observed_at`. Future timestamps and timestamps outside the
source's maximum age are rejected. For each source/location the newest
observation in the 30-minute maximum-age window is selected first. A null or
invalid value in that row is not filled from an older row from the same source;
the resolver tries the next source instead. This avoids assembling a response
from stale partial records.

Each resolved variable includes its value and unit, `source_id`, `location_id`,
`observed_at`, age in minutes, and `fallback` flag. A value selected from
Open-Meteo has `fallback: true`. If neither source provides a fresh valid value,
the variable is `null`.

## Conservative sanity limits

The broad bounds below reject non-finite values and obvious unit/data errors
without filtering merely unusual conditions. The returned endpoint includes
these limits as policy metadata.

| Variable | Accepted range | Rationale |
| --- | ---: | --- |
| Temperature | -90 to 60 °C | Broad terrestrial near-surface range |
| Solar radiation | 0 to 2,000 W/m² | Non-negative irradiance with headroom above ordinary surface peaks |
| Relative humidity | 0 to 100% | Physical percentage bounds |
| Pressure | 500 to 1,100 hPa | Broad surface-pressure range that allows high-elevation locations |
| Wind speed and gust | 0 to 500 km/h | Non-negative speeds with generous extreme-event headroom |
| Wind direction | 0 to 360° | Compass direction bounds |
| UV index | 0 to 30 | Non-negative index with extreme-UV headroom |
| Cloud cover | 0 to 100% | Physical percentage bounds |
| Visibility | 0 to 100,000 m | Non-negative visibility with generous upper bound |

Precipitation rate and total are deliberately excluded. Open-Meteo `current`
precipitation is an amount for its product interval, not a directly comparable
rate or daily total. The resolver performs no averaging, interpolation, or
quality-based source ranking.

## Scope and limitations

- Logical locations are matched by exact configured latitude and longitude.
- Only current per-variable values are resolved. `/api/stations`,
  `/api/observations/aggregate`, and `/api/quality/comparisons` continue to
  return their existing source-specific or raw-data behavior.
- `/api/summary.summaries` remains the original precomputed, source-specific
  summary; the fallback result is a separate property.
- Weather.com values are station measurements; Open-Meteo values are
  model-based estimates. The per-variable provenance must remain visible to
  consumers.