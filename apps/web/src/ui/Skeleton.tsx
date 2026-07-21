import { cx } from "./cx";

type Props = {
  className?: string;
  /** Convenience for a text-line skeleton: sets a short height + rounded ends. */
  variant?: "block" | "text" | "circle";
  width?: number | string;
  height?: number | string;
};

/** Content placeholder with a soft pulse — use while data loads. */
export function Skeleton({ className, variant = "block", width, height }: Props) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "block animate-pulse bg-fh-surface-muted",
        variant === "text" && "h-[0.7em] rounded",
        variant === "circle" && "rounded-full",
        variant === "block" && "rounded-md",
        className,
      )}
      style={{ width, height }}
    />
  );
}
