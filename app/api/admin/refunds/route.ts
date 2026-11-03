import { z } from "zod";
import { getAdminId } from "@/lib/guards";
import { isSameOrigin } from "@/lib/security/origin";
import { env } from "@/lib/env";
import { executeRefund } from "@/lib/payhere/refund";
import { audit } from "@/lib/audit";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const refundSchema = z.object({
  orderId: z.string().min(1).max(128),
  amountMinor: z.number().int().positive().optional(),
  reason: z.string().trim().min(3).max(200),
});

/**
 * Admin Refund Endpoint (POST /api/admin/refunds).
 * Enforces admin authorization, Same-Origin CSRF protection, and audit logging.
 */
export async function POST(request: Request) {
  try {
    const cfg = env();
    if (!isSameOrigin(request.headers.get("origin"), cfg.APP_URL)) {
      return Response.json({ error: "Invalid origin" }, { status: 403 });
    }

    const adminId = await getAdminId();
    if (!adminId) {
      return Response.json({ error: "Forbidden: Admin access required" }, { status: 403 });
    }

    const rawBody = await request.json().catch(() => null);
    const parsed = refundSchema.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
    }

    const { orderId, amountMinor, reason } = parsed.data;

    const result = await executeRefund({
      orderId,
      amountMinor,
      reason,
      adminId,
    });

    await audit(adminId, "admin_refund_attempted", {
      orderId,
      amountMinor,
      reason,
      success: result.success,
    });

    if (result.success) {
      return Response.json(result, { status: 200 });
    } else {
      const httpStatus = result.state === "UNKNOWN" ? 504 : 400;
      return Response.json(result, { status: httpStatus });
    }
  } catch (e) {
    log("error", "admin_refund_handler_failed", { error: String(e) });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

