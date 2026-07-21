import { cx } from "./cx";
import { readableTextOn } from "./color";

export type BadgeTone = "neutral" | "accent" | "success" | "danger" | "warning" | "purple";

type BadgeProps = {
  tone?: BadgeTone;
  /** Pill (fully rounded) vs. subtle rounded rectangle. */
  pill?: boolean;
  className?: string;
  children: React.ReactNode;
};

const tones: Record<BadgeTone, string> = {
  neutral: "text-fh-fg-muted bg-fh-neutral-muted",
  accent: "text-fh-accent-fg bg-fh-accent-muted",
  success: "text-fh-success-fg bg-fh-success-muted",
  danger: "text-fh-danger-fg bg-fh-danger-muted",
  warning: "text-fh-warning-fg bg-fh-warning-muted",
  purple: "text-fh-purple-fg bg-fh-purple-muted",
};

/** A small status pill in one of the semantic tones. */
export function Badge({ tone = "neutral", pill = true, className, children }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 px-2 py-0.5 text-fh-xs font-medium border border-transparent",
        pill ? "rounded-full" : "rounded",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

type LabelChipProps = {
  name: string;
  /** Arbitrary hex color (with or without leading #). */
  color: string;
  className?: string;
  onClick?: () => void;
  title?: string;
};

/**
 * A GitHub-style issue label chip filled with an arbitrary label color, with
 * ink auto-picked (black/white) for WCAG-legible contrast on that fill — works
 * in both themes because the fill is the label's own color.
 */
export function LabelChip({ name, color, className, onClick, title }: LabelChipProps) {
  const hex = color.startsWith("#") ? color : `#${color}`;
  const fg = readableTextOn(hex);
  const Comp = onClick ? "button" : "span";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title ?? name}
      className={cx(
        "inline-flex items-center max-w-full px-2 py-0.5 text-fh-xs font-semibold rounded-full border border-black/10 leading-[18px]",
        onClick && "cursor-pointer hover:brightness-95",
        className,
      )}
      style={{ backgroundColor: hex, color: fg }}
    >
      <span className="truncate">{name}</span>
    </Comp>
  );
}
