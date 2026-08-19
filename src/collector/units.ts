/**
 * Unit normalization utilities.
 *
 * Converts configured source units into the canonical units for each field.
 * Unsupported conversions throw a clear error so the caller can fail a single
 * request without aborting the whole collection run.
 */

export class UnitConversionError extends Error {}

function identity(value: number): number {
  return value;
}

function fahrenheitToCelsius(value: number): number {
  return ((value - 32) * 5) / 9;
}

function kelvinToCelsius(value: number): number {
  return value - 273.15;
}

function kilowattsToWatts(value: number): number {
  return value * 1000;
}

/**
 * Returns a converter for the canonical unit of a given field.
 *
 * The canonical units:
 *   temperature        -> C
 *   solar_radiation    -> W/m2
 *   humidity           -> %
 *   pressure           -> hPa
 *   wind_speed         -> km/h
 *   wind_direction     -> degrees
 *   wind_gust          -> km/h
 *   precipitation_rate -> mm/h
 *   precipitation_total-> mm
 */
export function getUnitConverter(
  field: string,
  unit?: string,
  convertTo?: string,
): (value: number) => number {
  const canonical = canonicalUnitFor(field);

  // No source unit -> assume canonical, no conversion.
  if (!unit) {
    if (convertTo) {
      throw new UnitConversionError(
        `Cannot convert field '${field}' to '${convertTo}' without a source unit`,
      );
    }
    return identity;
  }

  const table = conversionTableFor(field);
  if (!table) {
    throw new UnitConversionError(`No conversion table defined for field '${field}'`);
  }

  const fromCode = normalizeUnit(unit);
  const fromConverter = table[fromCode];
  if (!fromConverter) {
    throw new UnitConversionError(
      `Unsupported unit '${unit}' for field '${field}'. ` +
        `Supported: ${Object.keys(table).join(", ")}`,
    );
  }

  // If no target (or target is the canonical unit), convert source -> canonical.
  const toCode = convertTo ? normalizeUnit(convertTo) : canonical;
  const toConverter = table[toCode];
  if (!toConverter) {
    throw new UnitConversionError(
      `Unsupported target unit '${convertTo}' for field '${field}'. ` +
        `Supported: ${Object.keys(table).join(", ")}`,
    );
  }

  if (toCode !== canonical) {
    throw new UnitConversionError(
      `Conversion from '${unit}' to '${convertTo}' for field '${field}' is not supported. ` +
        `Only conversions to the canonical unit '${canonical}' are supported.`,
    );
  }

  // Convert from the source unit to the canonical unit (using the source
  // unit's own conversion, since canonical is the target).
  return (value) => fromConverter(value);
}

function canonicalUnitFor(field: string): string {
  switch (field) {
    case "temperature":
      return "C";
    case "solar_radiation":
      return "W/m2";
    case "humidity":
      return "%";
    case "pressure":
      return "hPa";
    case "wind_speed":
    case "wind_gust":
      return "km/h";
    case "wind_direction":
      return "degrees";
    case "precipitation_rate":
      return "mm/h";
    case "precipitation_total":
      return "mm";
    default:
      return "";
  }
}

function conversionTableFor(field: string): Record<string, (value: number) => number> | undefined {
  switch (field) {
    case "temperature":
      return {
        C: identity,
        F: fahrenheitToCelsius,
        K: kelvinToCelsius,
      };
    case "solar_radiation":
      return {
        "W/m2": identity,
        "kW/m2": kilowattsToWatts,
      };
    default: {
      const canonical = canonicalUnitFor(field);
      if (canonical) {
        return { [canonical]: identity };
      }
      return undefined;
    }
  }
}

/** Normalize a human-written unit string to a canonical key. */
function normalizeUnit(unit: string): string {
  const trimmed = unit.trim();
  const lower = trimmed.toLowerCase();
  const map: Record<string, string> = {
    "°c": "C",
    c: "C",
    celsius: "C",
    "°f": "F",
    f: "F",
    fahrenheit: "F",
    k: "K",
    kelvin: "K",
    "w/m2": "W/m2",
    "w/m²": "W/m2",
    "w/m^2": "W/m2",
    "kw/m2": "kW/m2",
    "kw/m²": "kW/m2",
    "kw/m^2": "kW/m2",
    "%": "%",
    percent: "%",
    hpa: "hPa",
    pa: "hPa",
    "km/h": "km/h",
    kph: "km/h",
    degrees: "degrees",
    deg: "degrees",
    "mm/h": "mm/h",
    "mm/hr": "mm/h",
    mm: "mm",
  };
  return map[lower] ?? trimmed;
}