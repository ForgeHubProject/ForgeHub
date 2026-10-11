export type RegistrationMode = "open" | "closed";

/** Reads FORGEHUB_REGISTRATION; unset/blank means "open". Throws on any other unknown value so a typo can't silently leave sign-up open. */
export function registrationMode(): RegistrationMode {
  const raw = process.env["FORGEHUB_REGISTRATION"]?.trim().toLowerCase();
  if (!raw) return "open";
  if (raw === "open" || raw === "closed") return raw;
  throw new Error(`FORGEHUB_REGISTRATION must be "open" or "closed" (got "${process.env["FORGEHUB_REGISTRATION"]}")`);
}
