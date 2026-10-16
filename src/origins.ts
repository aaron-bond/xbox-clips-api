/**
 * CORS origin matching (PLAN-v1.md §3). Entries are exact origins, or a
 * wildcard of the form `https://*.example.com`, which matches any subdomain of
 * example.com over that scheme and nothing else. The wildcard exists for the
 * UI's preview deployments, whose hostnames change per branch and per commit.
 */
export function parseAllowedOrigins(raw: string): string[] {
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

export function isAllowedOrigin(origin: string, allowed: string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // An Origin header is exactly scheme://host[:port]; anything more is not an origin.
  if (url.origin !== origin) return false;

  return allowed.some((entry) => {
    if (entry === origin) return true;
    const wildcard = /^(https?):\/\/\*\.([a-z0-9.-]+)$/i.exec(entry);
    if (!wildcard) return false;
    const [, scheme, suffix] = wildcard;
    return url.protocol === `${scheme!.toLowerCase()}:` && !url.port && url.hostname.endsWith(`.${suffix!.toLowerCase()}`);
  });
}
