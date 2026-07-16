'use strict';
// Host / Origin allowlist (the source of truth for DNS rebinding protection, shared by HTTP and the WebSocket upgrade)
// The core defense is the hostname allowlist: a rebinding attack's Host/Origin is the attacker's domain, and the port is irrelevant to the defense
// (not checking the port also lets the original Host:5178 forwarded by the vite dev proxy pass through)
// Extra allowlist entries are injected via env (for self-hosted remote access; comma-separated, e.g. RECENSA_ALLOWED_HOSTS=myhost.lan,192.168.1.10)
// The hostname is lowercased after URL parsing, so env values are always compared in lowercase
const EXTRA_HOSTS = (process.env.RECENSA_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
// `[::1]` is IPv6 loopback: new URL('http://[::1]:7788').hostname yields the BRACKETED form, so the allowlist entry
// must be bracketed (a bare `::1` Host fails URL parsing and would never match). Note: `Host: localhost#@evil.com`
// parses via new URL to hostname `localhost` and is thus allowed but not exploitable -- a browser will not inject a
// literal `#` into the Host header it sends under DNS-rebinding/CSRF, so no attacker-controlled origin reaches here.
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', ...EXTRA_HOSTS]);

/**
 * Validate a Host or Origin header.
 * @param {string|undefined} value  Host (host:port) or Origin (scheme://host:port)
 * @param {{allowMissing?: boolean}} opts  Origin may be absent (a same-origin GET omits it); Host must be present
 */
function isAllowedHost(value, { allowMissing = false } = {}) {
  if (!value) return allowMissing;
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`http://${value}`);
    return ALLOWED_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

// Safe (non-mutating) methods: a same-origin GET/HEAD legitimately omits the Origin header, so Origin stays optional
// for them. Every other method (POST/PUT/DELETE/PATCH/...) is state-changing and MUST carry an allowlisted Origin: a
// cross-site form/script cannot forge Origin, while a modern browser always attaches it to a same-origin mutating
// fetch -- so requiring it here rejects cross-origin CSRF writes without breaking the same-origin UI.
const ORIGIN_OPTIONAL_METHODS = new Set(['GET', 'HEAD']);

/**
 * Full request gate (DNS-rebinding + CSRF), the single rule shared by the HTTP middleware and the WebSocket upgrade.
 * Host must be present and allowlisted; Origin must be allowlisted, and must be PRESENT for mutating methods. A WS
 * handshake is a GET, so its Origin stays optional (unchanged from before).
 * @param {{host?: string, origin?: string, method?: string}} req  the header/method triple pulled off the request
 */
function isAllowedRequest({ host, origin, method = 'GET' } = {}) {
  if (!isAllowedHost(host)) return false;
  const allowMissing = ORIGIN_OPTIONAL_METHODS.has(String(method).toUpperCase());
  return isAllowedHost(origin, { allowMissing });
}

module.exports = { isAllowedHost, isAllowedRequest };
