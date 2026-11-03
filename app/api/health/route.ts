import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { error } = await db().from("payment_orders").select("order_id").limit(1);
    if (error) return Response.json({ ok: false }, { status: 503 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
