# Source comparison and quality signal

`GET /api/quality/comparisons` calculates current cross-source differences on
request. It reads the raw normalized observations and never writes, changes, or
removes meteorological data. No comparison history is stored.

## Pairing and time window

`weather_locations.id` is source-specific. Locations are treated as the same
logical place only when both configured latitude and longitude match exactly.
For each coordinate pair, the API searches observations collected in the most
recent 30 minutes and pairs valid times (`observed_at`) no more than 15 minutes
apart. At most one pair is returned per location pair and variable: the pair
with the newest shared valid time, then the smallest time difference. Values
that are null or non-finite are not compared.

The time tolerance accommodates the Open-Meteo current product's approximate
15-minute update interval against the collector's five-minute schedule. It does
not require equal timestamps.

## Divergence thresholds

| Variable | Divergence when absolute difference exceeds |
| --- | ---: |
| Temperature | 2 °C |
| Solar radiation | 100 W/m² |
| Relative humidity | 10 percentage points |
| Pressure | 5 hPa |
| Wind speed | 10 km/h |
| Wind direction | 30° circular difference |
| Wind gust | 15 km/h |
| Cloud cover | 20 percentage points |
| Visibility | 5,000 m |
| UV index | 2 index units |

When either paired wind speed is missing or below 3 km/h, wind direction is
returned as `not_comparable` because direction under calm conditions (or without
speed context) is not a useful quality signal. `precipitation_total` and
`precipitation_rate` are excluded: the sources' precipitation values do not have
sufficiently equivalent temporal semantics.

A `divergence` is only a signal that the two values differ beyond the configured
threshold. It does not establish which source is correct. Weather.com PWS values
are station observations while Open-Meteo current values are model-based
estimates; their provenance must be considered when interpreting the result.

The endpoint returns the variable, both values, source and location IDs,
observation and collection timestamps, absolute difference, threshold, time
separation, and status. Thresholds and the time window are constants in
`src/db/comparisons.ts` and are intentionally simple for the MVP.

## Limitations

- Exact coordinate matching is the logical location join. Coordinate changes
  or rounding differences can stop a pair from matching.
- The endpoint is a current diagnostic, not an audit trail; later observations
  replace the pair selected for each variable.
- Different measurement/model provenance and representativeness can produce
  legitimate differences. Thresholds should be interpreted as review signals,
  not source rankings.