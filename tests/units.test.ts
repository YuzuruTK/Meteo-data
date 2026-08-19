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

  it("accepts canonical unit when none specified (no-op)", () => {
    const convert = getUnitConverter("temperature");
    expect(convert(20)).toBeCloseTo(20, 5);
  });

  it("throws on unsupported unit", () => {
    expect(() => getUnitConverter("temperature", "warp")).toThrow(UnitConversionError);
  });

  it("throws on unsupported field with no table", () => {
    expect(() => getUnitConverter("unknown_field", "C")).toThrow(UnitConversionError);
  });

  it("throws on unsupported target conversion to non-canonical unit", () => {
    // Converting to a target other than the canonical unit is unsupported.
    expect(() => getUnitConverter("temperature", "C", "K")).toThrow(UnitConversionError);
  });
});