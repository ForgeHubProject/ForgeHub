/** "in 23 hours", "in 40 minutes", "in less than a minute": how long a transfer request has left (#256). */
export function expiresIn(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "in less than a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}
