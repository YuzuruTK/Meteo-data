import type { RequestConfig, WeatherLocationConfig } from "./types";

/**
 * Builds an HTTP request from a source's request config plus a specific
 * location. All location-specific values are injected via `location_param`.
 *
 * Supports secret interpolation: any `${ENV_VAR}` references in headers,
 * params, or URL are resolved from the provided `env` object. Missing secrets
 * produce a clear error and are never logged.
 */

export class RequestBuilderError extends Error {}

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RequestContext {
  [key: string]: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Resolve `${NAME}` references from the env/context. */
export function interpolateSecrets(value: string, env: RequestContext): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new RequestBuilderError(
        `Missing required secret/environment variable '${name}' referenced in request configuration`,
      );
    }
    return resolved;
  });
}

/**
 * Build the final request for a single source+location pair.
 */
export function buildRequest(
  requestConfig: RequestConfig,
  location: WeatherLocationConfig,
  env: RequestContext,
): BuiltRequest {
  // 1. Resolve URL (allow secret references in the URL string).
  const baseUrl = interpolateSecrets(requestConfig.url, env);

  // 2. Resolve headers (allow secret references).
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestConfig.headers ?? {})) {
    headers[key] = interpolateSecrets(value, env);
  }

  // 3. Resolve query params (allow secret references), then inject the
  //    location-specific parameter.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(requestConfig.params ?? {})) {
    params.set(key, interpolateSecrets(value, env));
  }
  if (requestConfig.location_param) {
    const locationValue = location[requestConfig.location_param];
    if (locationValue === undefined || locationValue === null) {
      throw new RequestBuilderError(
        `Location '${location.id}' is missing the required parameter '${requestConfig.location_param}'`,
      );
    }
    params.set(requestConfig.location_param, String(locationValue));
  }

  // 4. Assemble the URL.
  const url = new URL(baseUrl);
  for (const [key, value] of params.entries()) {
    url.searchParams.set(key, value);
  }

  // 5. Prepare body.
  let body: string | undefined;
  if (requestConfig.body !== undefined) {
    if (typeof requestConfig.body === "string") {
      body = interpolateSecrets(requestConfig.body, env);
    } else {
      body = JSON.stringify(requestConfig.body);
    }
  }

  return {
    method: requestConfig.method,
    url: url.toString(),
    headers,
    body,
  };
}

/** Default timeout helper for consumers. */
export function timeoutMsFor(requestConfig: RequestConfig): number {
  return requestConfig.timeout_ms ?? DEFAULT_TIMEOUT_MS;
}

export { DEFAULT_TIMEOUT_MS };