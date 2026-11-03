import "server-only";
import { db } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { computeRequestFingerprint, isValidIdempotencyKey } from "./idempotency-pure";

export { computeRequestFingerprint, isValidIdempotencyKey };

export type IdempotencyResult<T = unknown> =
  | { state: "ACQUIRED" }
  | { state: "REPLAY"; status: number; body: T }
  | { state: "IN_PROGRESS" }
  | { state: "CONFLICT"; error: string };

/**
 * Validates and locks an idempotency key for a specific user/tenant scope.
 * 
 * Invariants:
 * 1. Same key + Same payload -> Return cached result if completed, or IN_PROGRESS if currently processing.
 * 2. Same key + Different payload -> Return 409 CONFLICT to prevent payload tampering under a reused key.
 * 3. Fresh key -> Acquire lock and allow request to proceed.
 */
export async function acquireIdempotency<T = unknown>(
  scope: string,
  idempotencyKey: string,
  fingerprint: string,
  ttlSeconds = 86400, // 24-hour default retention
): Promise<IdempotencyResult<T>> {
  try {
    const { data: existing, error: selectErr } = await db()
      .from("idempotency_records")
      .select("status, request_fingerprint, response_status, response_body, expires_at")
      .eq("scope", scope)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (selectErr) {
      log("error", "idempotency_lookup_failed", { scope, idempotencyKey, error: selectErr.message });
      return { state: "ACQUIRED" };
    }

    if (existing) {
      if (new Date(existing.expires_at) < new Date()) {
        await db().from("idempotency_records").delete().eq("scope", scope).eq("idempotency_key", idempotencyKey);
      } else {
        if (existing.request_fingerprint !== fingerprint) {
          log("warn", "idempotency_conflict_detected", { scope, idempotencyKey });
          return {
            state: "CONFLICT",
            error: "This Idempotency-Key was already used with a different request payload.",
          };
        }

        if (existing.status === "COMPLETED" && existing.response_body) {
          return {
            state: "REPLAY",
            status: existing.response_status ?? 200,
            body: existing.response_body as T,
          };
        }

        if (existing.status === "IN_PROGRESS") {
          return { state: "IN_PROGRESS" };
        }
      }
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const { error: insertErr } = await db().from("idempotency_records").insert({
      scope,
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      status: "IN_PROGRESS",
      expires_at: expiresAt,
    });

    if (insertErr) {
      log("warn", "idempotency_race_detected", { scope, idempotencyKey, error: insertErr.message });
      return { state: "IN_PROGRESS" };
    }

    return { state: "ACQUIRED" };
  } catch (e) {
    log("error", "idempotency_error", { scope, idempotencyKey, error: String(e) });
    return { state: "ACQUIRED" };
  }
}

/**
 * Stores the final response for an acquired idempotency key.
 */
export async function completeIdempotency(
  scope: string,
  idempotencyKey: string,
  status: number,
  responseBody: unknown,
): Promise<void> {
  try {
    await db()
      .from("idempotency_records")
      .update({
        status: "COMPLETED",
        response_status: status,
        response_body: responseBody,
      })
      .eq("scope", scope)
      .eq("idempotency_key", idempotencyKey);
  } catch (e) {
    log("error", "complete_idempotency_failed", { scope, idempotencyKey, error: String(e) });
  }
}

/**
 * Clears an in-progress record if the initial transaction fails before commit, permitting customer retry.
 */
export async function releaseIdempotency(scope: string, idempotencyKey: string): Promise<void> {
  try {
    await db()
      .from("idempotency_records")
      .delete()
      .eq("scope", scope)
      .eq("idempotency_key", idempotencyKey);
  } catch (e) {
    log("error", "release_idempotency_failed", { scope, idempotencyKey, error: String(e) });
  }
}
