import { processOutboxQueue } from "@/lib/workers/outbox-worker";
import { log } from "@/lib/logger";
import { isAuthorizedCron } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Transactional Outbox Background Processing Endpoint.
 * Can be triggered via external cron job, Vercel cron, or admin dashboard.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return Response.json({ error: "Unauthorized cron trigger" }, { status: 401 });
  }

  try {
    const summary = await processOutboxQueue(20);
    return Response.json({ ok: true, summary }, { status: 200 });
  } catch (e) {
    log("error", "outbox_cron_execution_failed", { error: String(e) });
    return Response.json({ ok: false, error: "Outbox processing failed" }, { status: 500 });
  }
}

