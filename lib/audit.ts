import "server-only";
import { db } from "@/lib/supabase";
import { log } from "@/lib/logger";

export async function audit(actor: string, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const { error } = await db().from("audit_log").insert({ actor, action, detail });
    if (error) log("error", "audit_insert_failed", { action, error: error.message });
  } catch (e) {
    log("error", "audit_insert_threw", { action, error: String(e) });
  }
}
