# Open-Meteo current conditions source

The `open-meteo-current` collector source requests the `current` object from
the public [Open-Meteo Forecast API](https://open-meteo.com/en/docs) for each
configured location. It is separate from the existing forecast client used by
`/api/forecast`.

These values are model-based current-condition estimates, not observations
measured by the Weather.com stations. Open-Meteo documents current conditions
as based on 15-minute weather-model data. The response's `current.time` is the
valid time of the returned values; `current.interval` reports the interval in
seconds (currently 900 seconds in the verified response). The collector stores
the returned precipitation amount in millimetres as `precipitation_total` for
the interval represented by the current API value. It does not interpret that
amount as a daily accumulation or convert it into a precipitation rate.

The API responds with model-grid coordinates that can differ slightly from the
requested coordinates. The configured location coordinates remain the stable
location metadata stored by this project.

## Field mapping

| Canonical field | Open-Meteo `current` field | Input unit |
| --- | --- | --- |
| `observed_at` | `time` | ISO-8601 local representation with `timezone=UTC` |
| `temperature` | `temperature_2m` | °C |
| `solar_radiation` | `shortwave_radiation` | W/m² |
| `humidity` | `relative_humidity_2m` | % |
| `pressure` | `surface_pressure` | hPa |
| `wind_speed` | `wind_speed_10m` | km/h |
| `wind_direction` | `wind_direction_10m` | degrees |
| `wind_gust` | `wind_gusts_10m` | km/h |
| `precipitation_total` | `precipitation` | mm per API-reported current interval |
| `cloud_cover` | `cloud_cover` | % |
| `visibility` | `visibility` | m |
| `uv_index` | `uv_index` | dimensionless index |

Open-Meteo does not expose a distinct instantaneous precipitation-rate field in
this current response, so `precipitation_rate` is left `null`. Repeated five-
minute collection requests may return the same valid time; existing observation
deduplication by `(source_id, location_id, observed_at)` remains in effect.

For historical model reanalysis, see the separate
[Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api).
It is not used by this periodic current-conditions source.