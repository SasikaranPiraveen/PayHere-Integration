import { reconcileStalePendingPayments } from "@/lib/payhere/retrieval";
import { log } from "@/lib/logger";
import { isAuthorizedCron } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PayHere Retrieval API Reconciliation Cron Endpoint.
 * Can be triggered via external cron job, Vercel cron, or admin dashboard.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return Response.json({ error: "Unauthorized cron trigger" }, { status: 401 });
  }

  try {
    const summary = await reconcileStalePendingPayments(5, 60);
    return Response.json({ ok: true, summary }, { status: 200 });
  } catch (e) {
    log("error", "reconcile_cron_failed", { error: String(e) });
    return Response.json({ ok: false, error: "Reconciliation run failed" }, { status: 500 });
  }
}

