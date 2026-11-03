import "server-only";
import { z } from "zod";

// Treat `KEY=` (empty) in .env files the same as unset.
const optional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), s.optional());

const schema = z.object({
  PAYHERE_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYHERE_MERCHANT_ID: z.string().min(1),
  PAYHERE_MERCHANT_SECRET: z.string().min(1),
  // Merchant API (Retrieval/Refund) OAuth app; required only by refunds and reconciliation.
  PAYHERE_APP_ID: optional(z.string()),
  PAYHERE_APP_SECRET: optional(z.string()),
  APP_URL: z.string().url(),
  // Optional public base URL for PayHere server callbacks (e.g. a tunnel while paying from localhost).
  PAYHERE_NOTIFY_BASE_URL: optional(z.string().url()),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ADMIN_USER_IDS: z.string().default(""),
  CRON_SECRET: optional(z.string().min(16)),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

/** Validated lazily so `next build` works without secrets, but any request fails fast if misconfigured. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid or missing environment variables: ${names}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function appUrl(): string {
  return env().APP_URL.replace(/\/+$/, "");
}

/** Base URL PayHere posts notify callbacks to; falls back to APP_URL. */
export function notifyBaseUrl(): string {
  return (env().PAYHERE_NOTIFY_BASE_URL ?? env().APP_URL).replace(/\/+$/, "");
}

/** Merchant API (Retrieval/Refund) credentials; optional at boot so checkout works without them. */
export function merchantApiCredentials(): { appId: string; appSecret: string } {
  const { PAYHERE_APP_ID: appId, PAYHERE_APP_SECRET: appSecret } = env();
  if (!appId || !appSecret) {
    throw new Error("PAYHERE_APP_ID and PAYHERE_APP_SECRET are required for refunds and reconciliation");
  }
  return { appId, appSecret };
}

/** True only when CRON_SECRET is configured and the request presents it; fails closed otherwise. */
export function isAuthorizedCron(request: Request): boolean {
  const secret = env().CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

export function adminIds(): string[] {
  return env().ADMIN_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean);
}
