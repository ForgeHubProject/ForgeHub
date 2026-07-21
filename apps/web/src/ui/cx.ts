/**
 * Tiny className joiner. Accepts strings, falsy values (dropped), and
 * `{ "class": boolean }` maps. Keeps primitive markup readable without pulling
 * in a `clsx`/`classnames` dependency.
 */
export type ClassValue = string | number | false | null | undefined | Record<string, boolean>;

export function cx(...parts: ClassValue[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === "string" || typeof part === "number") {
      out.push(String(part));
    } else {
      for (const key in part) {
        if (part[key]) out.push(key);
      }
    }
  }
  return out.join(" ");
}
