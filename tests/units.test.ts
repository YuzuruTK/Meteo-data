import { describe, expect, it } from "vitest";
import { getUnitConverter, UnitConversionError } from "../src/collector/units";

describe("unit conversion", () => {
  it("converts 18°C to 18°C (canonical)", () => {
    const convert = getUnitConverter("temperature", "C");
    expect(convert(18)).toBeCloseTo(18, 5);
  });

  it("converts 68°F to 20°C", () => {
    const convert = getUnitConverter("temperature", "F");
    expect(convert(68)).toBeCloseTo(20, 5);
  });

  it("converts 0.812 kW/m2 to 812 W/m2", () => {
    const convert = getUnitConverter("solar_radiation", "kW/m2");
    expect(convert(0.812)).toBeCloseTo(812, 5);
  });

  it.each([
    ["pressure", "Pa", 101325, 1013.25],
    ["pressure", "kPa", 101.325, 1013.25],
    ["pressure", "bar", 1, 1000],
    ["pressure", "atm", 1, 1013.25],
    ["pressure", "inHg", 1, 33.8638866667],
    ["wind_speed", "m/s", 10, 36],
    ["wind_speed", "mph", 10, 16.09344],
    ["wind_speed", "knots", 10, 18.52],
    ["wind_gust", "m/s", 10, 36],
    ["wind_gust", "mph", 10, 16.09344],
    ["wind_gust", "knots", 10, 18.52],
    ["wind_direction", "radians", Math.PI, 180],
    ["precipitation_rate", "in/hr", 1, 25.4],
    ["precipitation_rate", "mm/min", 1, 60],
    ["precipitation_total", "inches", 1, 25.4],
    ["precipitation_total", "cm", 1, 10],
    ["cloud_cover", "fraction", 0.5, 50],
    ["visibility", "km", 1, 1000],
    ["visibility", "ft", 1000, 304.8],
  ])("converts %s from %s to its canonical unit", (field, unit, input, expected) => {
    expect(getUnitConverter(field, unit)(input)).toBeCloseTo(expected, 5);
  });

  it("accepts canonical unit aliases as identity conversions", () => {
    const cases: Array<[string, string, number]> = [
      ["pressure", "mbar", 1013.25],
      ["wind_speed", "kph", 36],
      ["wind_gust", "km/h", 42],
      ["wind_direction", "deg", 270],
      ["precipitation_rate", "mm/hour", 2.5],
      ["precipitation_total", "mm", 12],
      ["cloud_cover", "%", 70],
      ["visibility", "meters", 5000],
      ["uv_index", "index", 8],
    ];
    for (const [field, unit, value] of cases) {
      expect(getUnitConverter(field, unit)(value), `${field} ${unit}`).toBe(value);
    }
  });

  it("accepts canonical unit when none specified (no-op)", () => {
    const convert = getUnitConverter("temperature");
    expect(convert(20)).toBeCloseTo(20, 5);
    expect(getUnitConverter("uv_index")(7)).toBe(7);
  });

  it("throws on unsupported unit", () => {
    expect(() => getUnitConverter("temperature", "warp")).toThrow(UnitConversionError);
  });

  it("throws on unsupported field with no table", () => {
    expect(() => getUnitConverter("unknown_field", "C")).toThrow(UnitConversionError);
    expect(() => getUnitConverter("unknown_field")).toThrow(UnitConversionError);
  });

  it("rejects units that are unknown, empty, or incompatible with the field", () => {
    expect(() => getUnitConverter("temperature", "warp")).toThrow(UnitConversionError);
    expect(() => getUnitConverter("pressure", "")).toThrow(UnitConversionError);
    expect(() => getUnitConverter("pressure", "C")).toThrow(UnitConversionError);
    expect(() => getUnitConverter("cloud_cover", "km/h")).toThrow(UnitConversionError);
    expect(() => getUnitConverter("temperature", "constructor")).toThrow(UnitConversionError);
  });

  it("rejects non-finite values instead of returning invalid conversions", () => {
    expect(() => getUnitConverter("temperature", "C")(Number.NaN)).toThrow(UnitConversionError);
    expect(() => getUnitConverter("wind_speed", "m/s")(Number.MAX_VALUE)).toThrow(UnitConversionError);
  });

  it("rejects non-canonical targets and targets without an explicit source unit", () => {
    expect(() => getUnitConverter("temperature", "C", "K")).toThrow(UnitConversionError);
    expect(() => getUnitConverter("temperature", undefined, "C")).toThrow(UnitConversionError);
  });

  it("throws on unsupported target conversion to non-canonical unit", () => {
    // Converting to a target other than the canonical unit is unsupported.
    expect(() => getUnitConverter("temperature", "C", "K")).toThrow(UnitConversionError);
  });
});