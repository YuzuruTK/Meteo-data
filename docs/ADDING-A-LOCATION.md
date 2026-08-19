# Adding a location to an existing source

To collect data from an additional location for an already-configured API, edit **only** the `locations` array of that source in `config/weather-sources.json`. No source-code changes are required.

## Example: adding a station to the Weather.com source

The Weather.com source uses `location_param: "stationId"`, so each location must include a `stationId` value. Find the source in `config/weather-sources.json` and add another object to its `locations` array:

```json
{
  "id": "weather-com-pws",
  "enabled": true,
  "request": {
    "method": "GET",
    "url": "https://api.weather.com/v2/pws/observations/current",
    "params": {
      "apikey": "${WEATHER_COM_API_KEY}",
      "units": "m",
      "format": "json"
    },
    "location_param": "stationId"
  },
  "locations": [
    {
      "id": "ijui-iiJu2",
      "name": "Ijuí",
      "stationId": "IIJU2",
      "latitude": -28.391268,
      "longitude": -53.926267
    },
    {
      "id": "my-new-location",
      "name": "My New Station",
      "stationId": "XXXXX",
      "latitude": -10.0,
      "longitude": -50.0
    }
  ],
  "normalization": { "...": "unchanged..." }
}
```

The Worker will now automatically issue a separate request for the new location on every 5-minute run — reusing the same URL, params, headers, and normalization as the source.

## Location fields

| Field | Required? | Notes |
| --- | --- | --- |
| `id` | Yes | Unique within the source; used as the DB location id. |
| `name` | Yes | Human-readable name. |
| `latitude` / `longitude` | No | Optional; used to enrich the `weather_locations` row. Configured coords are never overwritten by API-provided ones. |
| Any location param (e.g. `stationId`) | Only if the source's `request.location_param` is set | The value injected into the request query params. |

## Rules

- `id` must be unique **within the source** (duplicate ids are rejected at validation).
- If the source declares `request.location_param`, every location must supply that key or the config fails validation.
- Adding a location never requires touching `request` or `normalization` — those stay at the source level.