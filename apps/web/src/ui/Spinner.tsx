import { cx } from "./cx";

type Props = {
  /** Diameter in px. */
  size?: number;
  className?: string;
  /** Accessible label; omit for a purely decorative spinner. */
  label?: string;
};

/** Indeterminate loading spinner — a rotating ring in the current text color. */
export function Spinner({ size = 16, className, label }: Props) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      className={cx("inline-block align-[-0.125em] animate-fh-spin", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path
          d="M15 8a7 7 0 0 0-7-7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
