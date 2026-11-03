const isDev = process.env.NODE_ENV !== "production";

// CSP ships as Report-Only by default so rollout can't break on Clerk's script hosts.
// Set CSP_MODE=enforce once you have verified there are no violations in the browser console.
// For a Clerk production instance also add your Clerk custom domain (https://clerk.<yourdomain>).
// PayHere JS SDK (popup) loads its script and iframe from these hosts.
const PAYHERE = "https://www.payhere.lk https://sandbox.payhere.lk";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com ${PAYHERE}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: https://img.clerk.com ${PAYHERE}`,
  "font-src 'self' data:",
  `connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com ${PAYHERE}`,
  `frame-src https://challenges.cloudflare.com https://*.clerk.accounts.dev ${PAYHERE}`,
  "worker-src 'self' blob:",
  "form-action 'self' https://sandbox.payhere.lk https://www.payhere.lk",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

// The dev server blocks cross-origin requests to its dev assets (HMR, chunks) from any host but
// localhost; allow the tunnel host from APP_URL so the app hydrates when opened through ngrok.
const tunnelHost = (() => {
  try {
    return new URL(process.env.APP_URL ?? "").hostname;
  } catch {
    return undefined;
  }
})();

const nextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: tunnelHost ? [tunnelHost] : [],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: process.env.CSP_MODE === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", value: csp },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // NOT "no-referrer": PayHere authorizes the checkout by the browser Referer.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
