import { validateConfig, ConfigValidationError } from "../collector/validate";
import type { WeatherSourcesConfig } from "../collector/types";

/**
 * Loads and validates the weather sources configuration.
 *
 * The config is imported statically so it is bundled at build time. Validation
 * runs once per Worker invocation (cheap) and throws at startup if the config
 * is malformed.
 */

// Static import resolves the JSON at build time.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import rawConfig from "./weather-sources.json";

export { ConfigValidationError };

let cached: WeatherSourcesConfig | undefined;

/**
 * Return the validated config. The result is cached for the lifetime of the
 * Worker isolate.
 */
export function loadConfig(): WeatherSourcesConfig {
  if (cached) {
    return cached;
  }

  const config = rawConfig as WeatherSourcesConfig;
  validateConfig(config);
  cached = config;
  return config;
}

/**
 * Load config without caching (useful for tests).
 */
export function parseAndValidate(
  input: WeatherSourcesConfig | unknown,
): WeatherSourcesConfig {
  validateConfig(input as WeatherSourcesConfig);
  return input as WeatherSourcesConfig;
}

/**
 * Load the enabled sources only.
 */
export function loadEnabledSources(): WeatherSourcesConfig {
  return loadConfig().filter((source) => source.enabled);
}