import { describe, expect, it } from "vitest";
import { parseJsonPath, getByPath, jsonPath } from "../src/collector/json-path";

const data = {
  observations: [
    { metric: { temp: 18 }, solarRadiation: 0, humidity: 99 },
  ],
  current: { temperature: { value: 21 } },
  weird: { "with space": 7 },
};

describe("json-path", () => {
  it("extracts nested dot notation", () => {
    expect(jsonPath(data, "$.observations[0].metric.temp")).toBe(18);
  });

  it("extracts indexed array element", () => {
    expect(jsonPath(data, "$.observations[0]")).toEqual({
      metric: { temp: 18 },
      solarRadiation: 0,
      humidity: 99,
    });
  });

  it("extracts deep nested field", () => {
    expect(jsonPath(data, "$.observations[0].metric")).toEqual({ temp: 18 });
  });

  it("supports bracket notation with quotes", () => {
    expect(jsonPath(data, "$['weird']['with space']")).toBe(7);
  });

  it("returns undefined for missing path", () => {
    expect(jsonPath(data, "$.observations[0].missing")).toBeUndefined();
  });

  it("returns undefined when traversing a non-object", () => {
    expect(jsonPath(data, "$.observations[0].metric.temp.deep")).toBeUndefined();
  });

  it("returns undefined for out-of-range index", () => {
    expect(jsonPath(data, "$.observations[5]")).toBeUndefined();
  });

  it("parses segments correctly for getByPath", () => {
    const segments = parseJsonPath("$.observations[0].metric.temp");
    expect(getByPath(data, segments)).toBe(18);
  });

  it("throws on malformed path", () => {
    expect(() => parseJsonPath("observations[0]")).toThrow();
    expect(() => parseJsonPath("$.a..b")).toThrow();
  });
});