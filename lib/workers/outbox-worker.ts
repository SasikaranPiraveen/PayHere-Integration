import "server-only";
import { db } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { executeOrderFulfillment, type FulfillmentPayload } from "@/lib/fulfillment/service";

export type OutboxEventRow = {
  id: number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  operation_key: string;
  payload: unknown;
  status: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_retry_at: string;
};

/**
 * Transactional Outbox Worker.
 * 
 * Invariants:
 * 1. Claims pending / retryable outbox events with due next_retry_at.
 * 2. Processes events asynchronously outside the webhook critical path.
 * 3. Applies exponential backoff with jitter on transient failures.
 * 4. Moves permanently failing events to DEAD_LETTER after max_attempts.
 */
export async function processOutboxQueue(batchSize = 10): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const now = new Date().toISOString();

  // Fetch pending or retryable failed events
  const { data: events, error: fetchErr } = await db()
    .from("outbox_events")
    .select("*")
    .in("status", ["PENDING", "FAILED"])
    .lte("next_retry_at", now)
    .order("id", { ascending: true })
    .limit(batchSize);

  if (fetchErr) {
    log("error", "outbox_poll_failed", { error: fetchErr.message });
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  if (!events || events.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;

  for (const event of events as OutboxEventRow[]) {
    // Optimistically mark PROCESSING
    await db()
      .from("outbox_events")
      .update({ status: "PROCESSING", updated_at: new Date().toISOString() })
      .eq("id", event.id);

    let result: { success: boolean; error?: string } = { success: false };

    try {
      if (event.event_type === "FULFILL_ORDER") {
        result = await executeOrderFulfillment(event.payload as FulfillmentPayload);
      } else if (event.event_type === "PAYMENT_OVERPAYMENT_REVIEW") {
        log("warn", "overpayment_review_alert_processed", { payload: event.payload });
        result = { success: true };
      } else {
        log("warn", "unknown_outbox_event_type", { eventType: event.event_type });
        result = { success: true };
      }
    } catch (e) {
      result = { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (result.success) {
      succeeded += 1;
      await db()
        .from("outbox_events")
        .update({
          status: "SUCCEEDED",
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", event.id);
    } else {
      failed += 1;
      const nextAttempt = event.attempts + 1;
      const isDeadLetter = nextAttempt >= event.max_attempts;

      // Exponential backoff with random jitter: 10s * 2^attempt + jitter
      const backoffSeconds = Math.min(10 * Math.pow(2, nextAttempt), 3600);
      const jitterMs = Math.floor(Math.random() * 5000);
      const nextRetryAt = new Date(Date.now() + backoffSeconds * 1000 + jitterMs).toISOString();

      await db()
        .from("outbox_events")
        .update({
          status: isDeadLetter ? "DEAD_LETTER" : "FAILED",
          attempts: nextAttempt,
          last_error: result.error ?? "Unknown failure",
          next_retry_at: nextRetryAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", event.id);

      if (isDeadLetter) {
        log("error", "outbox_event_dead_letter", {
          eventId: event.id,
          operationKey: event.operation_key,
          error: result.error,
        });
      }
    }
  }

  return { processed: events.length, succeeded, failed };
}

