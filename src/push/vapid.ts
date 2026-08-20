/**
 * VAPID configuration helpers.
 *
 * The heavy lifting (JWT signing, RFC 8291 payload encryption, sending) is
 * delegated to the `web-push` library, which runs under Wrangler's
 * `nodejs_compat` compatibility flag. This module only centralizes reading the
 * VAPID keys from the environment and small base64url utilities used by the
 * rest of the push module.
 */

const PUBLIC_KEY_PREFIX = "-----BEGIN PUBLIC KEY-----";
const PUBLIC_KEY_SUFFIX = "-----END PUBLIC KEY-----";

/** Convert raw bytes to a base64url string (URL-safe, unpadded). */
export function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Convert a base64url string to bytes. */
export function fromBase64Url(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Normalize a VAPID public key for delivery to the frontend. Accepts the
 * base64url string produced by `npx web-push generate-vapid-keys` and strips
 * any whitespace/trailing padding.
 */
export function normalizePublicKey(key: string): string {
  if (key.includes(PUBLIC_KEY_PREFIX)) {
    const base64 = key
      .replace(PUBLIC_KEY_PREFIX, "")
      .replace(PUBLIC_KEY_SUFFIX, "")
      .replace(/\s+/g, "");
    return base64.replace(/=+$/g, "");
  }
  return key.replace(/\s+/g, "").replace(/=+$/g, "");
}

/** The URL-safe base64url form of a VAPID public key for the browser. */
export function urlB64ToUint8Array(base64String: string): Uint8Array {
  return fromBase64Url(base64String);
}