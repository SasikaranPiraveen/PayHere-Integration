// CSRF-style defence for cookie-authenticated, state-changing routes: require same Origin.
export function isSameOrigin(originHeader: string | null, appUrl: string): boolean {
  if (!originHeader) return false;
  try {
    return new URL(originHeader).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Extracts and sanitizes the client IP for rate-limiting purposes.
 * Prefers Cloudflare CF-Connecting-IP, then X-Real-IP, then the first valid hop in X-Forwarded-For.
 * Strips port numbers and rejects invalid strings to prevent key injection into the rate limit store.
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  if (cfIp && isValidIpFormat(cfIp)) return cfIp;

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && isValidIpFormat(realIp)) return realIp;

  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const firstHop = xff.split(",")[0].trim();
    if (isValidIpFormat(firstHop)) return firstHop;
  }

  return "unknown";
}

function isValidIpFormat(ip: string): boolean {
  // Checks basic IPv4 (e.g. 1.2.3.4) or IPv6 format
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return ipv4.test(ip) || ipv6.test(ip);
}
