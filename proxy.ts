// Next.js 16+: this file is `proxy.ts`. On Next.js 15 or older, rename it to `middleware.ts` (contents identical).
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public: landing, auth pages, health, and the PayHere webhook (PayHere is not a logged-in user;
// the webhook authenticates itself with the md5sig signature instead of a session).
const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)", "/api/payhere/notify", "/api/health"]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
