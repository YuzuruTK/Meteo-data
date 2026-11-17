/**
 * Unit normalization utilities.
 *
 * Converts configured source units into canonical units. When `unit` is
 * omitted for a supported field, the input is explicitly assumed to already
 * use that field's canonical unit. Unknown fields and incompatible/unknown
 * units are rejected instead of silently treated as canonical.
 */

export class UnitConversionError extends Error {}

/** Canonical units: °C, W/m², %, hPa, km/h, degrees, mm/h, mm, %, m, UV index. */

type UnitDefinition = {
  canonical: string;
  aliases: Record<string, (value: number) => number>;
};

const identity = (value: number): number => value;
const celsiusToCelsius = identity;
const fahrenheitToCelsius = (value: number): number => ((value - 32) * 5) / 9;
const kelvinToCelsius = (value: number): number => value - 273.15;

const UNIT_DEFINITIONS: Record<string, UnitDefinition> = {
  temperature: {
    canonical: "C",
    aliases: {
      c: celsiusToCelsius,
      "°c": celsiusToCelsius,
      celsius: celsiusToCelsius,
      f: fahrenheitToCelsius,
      "°f": fahrenheitToCelsius,
      fahrenheit: fahrenheitToCelsius,
      k: kelvinToCelsius,
      kelvin: kelvinToCelsius,
    },
  },
  solar_radiation: {
    canonical: "W/m2",
    aliases: {
      "w/m2": identity,
      "w/m²": identity,
      "w/m^2": identity,
      "kw/m2": (value) => value * 1000,
      "kw/m²": (value) => value * 1000,
      "kw/m^2": (value) => value * 1000,
    },
  },
  humidity: {
    canonical: "%",
    aliases: {
      "%": identity,
      percent: identity,
      percentage: identity,
      fraction: (value) => value * 100,
      "1": (value) => value * 100,
    },
  },
  pressure: {
    canonical: "hPa",
    aliases: {
      hpa: identity,
      mbar: identity,
      mb: identity,
      pa: (value) => value / 100,
      kpa: (value) => value * 10,
      bar: (value) => value * 1000,
      atm: (value) => value * 1013.25,
      inhg: (value) => value * 33.8638866667,
      mmhg: (value) => value * 1.33322387415,
    },
  },
  wind_speed: {
    canonical: "km/h",
    aliases: {
      "km/h": identity,
      kmh: identity,
      kph: identity,
      "m/s": (value) => value * 3.6,
      "mps": (value) => value * 3.6,
      mph: (value) => value * 1.609344,
      knot: (value) => value * 1.852,
      knots: (value) => value * 1.852,
      kt: (value) => value * 1.852,
      kts: (value) => value * 1.852,
    },
  },
  wind_gust: {
    canonical: "km/h",
    aliases: {
      "km/h": identity,
      kmh: identity,
      kph: identity,
      "m/s": (value) => value * 3.6,
      "mps": (value) => value * 3.6,
      mph: (value) => value * 1.609344,
      knot: (value) => value * 1.852,
      knots: (value) => value * 1.852,
      kt: (value) => value * 1.852,
      kts: (value) => value * 1.852,
    },
  },
  wind_direction: {
    canonical: "degrees",
    aliases: {
      degree: identity,
      degrees: identity,
      deg: identity,
      "°": identity,
      radian: (value) => value * (180 / Math.PI),
      radians: (value) => value * (180 / Math.PI),
      rad: (value) => value * (180 / Math.PI),
    },
  },
  precipitation_rate: {
    canonical: "mm/h",
    aliases: {
      "mm/h": identity,
      "mm/hr": identity,
      "mm/hour": identity,
      "mm/min": (value) => value * 60,
      inhg: (value) => value * 33.8638866667,
      "in/hr": (value) => value * 25.4,
      "in/hour": (value) => value * 25.4,
    },
  },
  precipitation_total: {
    canonical: "mm",
    aliases: {
      mm: identity,
      cm: (value) => value * 10,
      m: (value) => value * 1000,
      in: (value) => value * 25.4,
      inch: (value) => value * 25.4,
      inches: (value) => value * 25.4,
    },
  },
  cloud_cover: {
    canonical: "%",
    aliases: {
      "%": identity,
      percent: identity,
      percentage: identity,
      fraction: (value) => value * 100,
      "1": (value) => value * 100,
    },
  },
  visibility: {
    canonical: "m",
    aliases: {
      m: identity,
      meter: identity,
      meters: identity,
      metre: identity,
      metres: identity,
      km: (value) => value * 1000,
      kilometer: (value) => value * 1000,
      kilometers: (value) => value * 1000,
      kilometre: (value) => value * 1000,
      kilometres: (value) => value * 1000,
      ft: (value) => value * 0.3048,
      foot: (value) => value * 0.3048,
      feet: (value) => value * 0.3048,
      mi: (value) => value * 1609.344,
      mile: (value) => value * 1609.344,
      miles: (value) => value * 1609.344,
    },
  },
  // UV index is a dimensionless index, so there is no physical unit conversion.
  uv_index: { canonical: "index", aliases: { index: identity, uv: identity } },
};

/**
 * Returns a converter from a configured source unit to the canonical unit.
 * If no source unit is supplied, values for known fields are assumed to
 * already be in the canonical unit. `convertTo`, when provided, must resolve
 * to the canonical unit; arbitrary target-unit conversion is not supported.
 */
export function getUnitConverter(
  field: string,
  unit?: string,
  convertTo?: string,
): (value: number) => number {
  if (!Object.prototype.hasOwnProperty.call(UNIT_DEFINITIONS, field)) {
    throw new UnitConversionError(`No conversion table defined for field '${field}'`);
  }
  const definition = UNIT_DEFINITIONS[field]!;

  if (unit === undefined) {
    if (convertTo !== undefined) {
      throw new UnitConversionError(
        `Cannot convert field '${field}' to '${convertTo}' without a source unit`,
      );
    }
    return validateFiniteConversion(field, identity);
  }
  if (unit.trim() === "") {
    throw new UnitConversionError(`Unsupported empty unit for field '${field}'`);
  }

  const unitKey = normalizeUnit(unit);
  if (!Object.prototype.hasOwnProperty.call(definition.aliases, unitKey)) {
    throw new UnitConversionError(
      `Unsupported unit '${unit}' for field '${field}'. ` +
        `Supported: ${Object.keys(definition.aliases).join(", ")}`,
    );
  }
  const converter = definition.aliases[unitKey]!;

  if (convertTo !== undefined) {
    const targetKey = normalizeUnit(convertTo);
    const canonicalKey = normalizeUnit(definition.canonical);
    if (targetKey !== canonicalKey) {
      throw new UnitConversionError(
        `Conversion from '${unit}' to '${convertTo}' for field '${field}' is not supported. ` +
          `Only conversions to the canonical unit '${definition.canonical}' are supported.`,
      );
    }
  }

  return validateFiniteConversion(field, converter);
}

function validateFiniteConversion(
  field: string,
  converter: (value: number) => number,
): (value: number) => number {
  return (value) => {
    if (!Number.isFinite(value)) {
      throw new UnitConversionError(`Value for field '${field}' must be a finite number`);
    }
    const converted = converter(value);
    if (!Number.isFinite(converted)) {
      throw new UnitConversionError(`Conversion result for field '${field}' is not finite`);
    }
    return converted;
  };
}

/** Normalize case and surrounding/duplicate whitespace for lookup. */
function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, " ");
}