import { useState } from "react";
import { cx } from "./cx";

type Props = {
  /** Display name or handle — drives the deterministic fallback. */
  name: string;
  src?: string | null;
  size?: number;
  /** Square with rounded corners (repos/orgs) instead of a circle. */
  square?: boolean;
  className?: string;
  title?: string;
};

// Cool, slightly-blue-cast fallback tints that sit under white initials and
// read as part of the FH identity rather than a random rainbow.
const FALLBACK_BG = [
  "#0b7fab", "#2a8f6f", "#7a52c7", "#b0791f",
  "#3f7bd0", "#158a86", "#a24a8f", "#4a6bd0",
];

/** Deterministically hash a string to a stable palette index. */
function hashIndex(str: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

/**
 * User/repo avatar: renders `src` when it loads, otherwise a deterministic
 * colored tile with the name's initial. The fallback is stable per name, so the
 * same user always gets the same tint.
 */
export function Avatar({ name, src, size = 24, square = false, className, title }: Props) {
  const [broken, setBroken] = useState(false);
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const bg = FALLBACK_BG[hashIndex(name || "?", FALLBACK_BG.length)];
  const rounded = square ? "rounded-md" : "rounded-full";

  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name}
        title={title ?? name}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={cx("object-cover flex-shrink-0 border border-black/5", rounded, className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      title={title ?? name}
      aria-label={name}
      className={cx(
        "inline-flex items-center justify-center flex-shrink-0 font-semibold text-white select-none",
        rounded,
        className,
      )}
      style={{ width: size, height: size, backgroundColor: bg, fontSize: Math.round(size * 0.46) }}
    >
      {initial}
    </span>
  );
}
