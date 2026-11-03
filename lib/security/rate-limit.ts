import "server-only";
import { db } from "@/lib/supabase";
import { log } from "@/lib/logger";

/** Returns true when the call is allowed. On DB failure: fail-closed by default, fail-open when asked. */
export async function rateLimit(key: string, windowSeconds: number, max: number, failOpen = false): Promise<boolean> {
  try {
    const { data, error } = await db().rpc("rate_limit_hit", {
      p_key: key, p_window_seconds: windowSeconds, p_max: max,
    });
    if (error) {
      log("error", "rate_limit_error", { key, error: error.message });
      return failOpen;
    }
    return data === true;
  } catch (e) {
    log("error", "rate_limit_threw", { key, error: String(e) });
    return failOpen;
  }
}
