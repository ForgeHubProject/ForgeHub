/**
 * Best-effort human label for a session's User-Agent string (issue #117): the
 * browser and OS when we can spot them, else a trimmed raw UA. Purely cosmetic —
 * the sessions page also shows the raw UA, so nothing is hidden.
 */
export function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\/|Opera/.test(ua) ? "Opera" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Safari\//.test(ua) ? "Safari" :
    /curl\//.test(ua) ? "curl" :
    /git\//.test(ua) ? "git" :
    null;
  const os =
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X|Macintosh/.test(ua) ? "macOS" :
    /Android/.test(ua) ? "Android" :
    /iPhone|iPad|iOS/.test(ua) ? "iOS" :
    /Linux/.test(ua) ? "Linux" :
    null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return ua.length > 48 ? `${ua.slice(0, 48)}…` : ua;
}
