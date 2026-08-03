import { cx } from "./cx";
import { readableTextOn } from "./color";

export type BadgeTone = "neutral" | "accent" | "success" | "danger" | "warning" | "purple";
export type BadgeVariant = "solid" | "outline";

type BadgeProps = {
  tone?: BadgeTone;
  /**
   * `solid` (default) fills with the tone's wash; `outline` is the GitHub-style
   * bordered pill on a transparent ground — the shape for visibility chips
   * ("Public" / "Private") and other quiet metadata.
   */
  variant?: BadgeVariant;
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

const outlineTones: Record<BadgeTone, string> = {
  neutral: "text-fh-fg-muted border-fh-border",
  accent: "text-fh-accent-fg border-fh-accent-emphasis/40",
  success: "text-fh-success-fg border-fh-success-emphasis/40",
  danger: "text-fh-danger-fg border-fh-danger-emphasis/40",
  warning: "text-fh-warning-fg border-fh-warning-emphasis/40",
  purple: "text-fh-purple-fg border-fh-purple-emphasis/40",
};

/** A small status pill in one of the semantic tones. */
export function Badge({ tone = "neutral", variant = "solid", pill = true, className, children }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 px-2 py-0.5 text-fh-xs font-medium border",
        pill ? "rounded-full" : "rounded",
        variant === "outline" ? outlineTones[tone] : cx("border-transparent", tones[tone]),
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
