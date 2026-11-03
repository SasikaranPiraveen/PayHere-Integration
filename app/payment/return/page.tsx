import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { getUserId } from "@/lib/guards";
import { StatusPoller } from "./StatusPoller";

export const dynamic = "force-dynamic";

// The return URL carries NO trusted payment status. We only READ our database here; never write.
export default async function ReturnPage({ searchParams }: { searchParams: Promise<{ orderId?: string }> }) {
  const { orderId } = await searchParams;
  const userId = await getUserId();
  if (!orderId || !userId) notFound();

  const { data } = await db()
    .from("payment_orders")
    .select("order_id, description, status")
    .eq("order_id", orderId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) notFound();

  return (
    <>
      <h1>Payment result</h1>
      <p className="muted">{data.description}</p>
      <StatusPoller orderId={data.order_id} initialStatus={data.status} />
    </>
  );
}
