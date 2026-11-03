import { createHash } from "node:crypto";

/**
 * Validates that an idempotency key conforms to safe length and character rules.
 * Accepts alphanumeric, hyphens, and underscores between 8 and 128 characters.
 */
export function isValidIdempotencyKey(key: string | null | undefined): boolean {
  if (!key || typeof key !== "string") return false;
  return /^[a-zA-Z0-9_-]{8,128}$/.test(key);
}

/**
 * Creates a deterministic, canonical SHA-256 hash of any JSON-serializable request payload.
 * Object keys are sorted recursively to ensure identical hashes regardless of object key order.
 */
export function computeRequestFingerprint(payload: unknown): string {
  function canonicalize(val: unknown): unknown {
    if (val === null || typeof val !== "object") return val;
    if (Array.isArray(val)) return val.map(canonicalize);
    const sortedObj: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      sortedObj[key] = canonicalize((val as Record<string, unknown>)[key]);
    }
    return sortedObj;
  }

  const str = JSON.stringify(canonicalize(payload) ?? {});
  return createHash("sha256").update(str, "utf8").digest("hex");
}

