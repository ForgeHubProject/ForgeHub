import { forwardRef } from "react";
import { cx } from "./cx";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "default" | "danger" | "invisible";
export type ButtonSize = "sm" | "md";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a spinner and disable interaction. */
  loading?: boolean;
  /** Leading icon element (rendered before children). */
  leadingIcon?: React.ReactNode;
  /** Trailing icon element (rendered after children). */
  trailingIcon?: React.ReactNode;
  /** Stretch to fill the container width. */
  block?: boolean;
};

const base =
  "inline-flex items-center justify-center gap-1.5 font-medium rounded-md border " +
  "cursor-pointer select-none whitespace-nowrap transition-colors duration-100 " +
  "disabled:opacity-60 disabled:cursor-not-allowed disabled:pointer-events-none";

const sizes: Record<ButtonSize, string> = {
  sm: "h-6 px-2 text-fh-sm leading-none",
  md: "h-8 px-3 text-fh-base leading-none",
};

const variants: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-fh-accent-emphasis text-fh-on-emphasis hover:bg-fh-accent-emphasis-hover",
  default:
    "border-fh-border bg-fh-surface text-fh-fg hover:bg-fh-surface-muted hover:border-fh-border-strong",
  danger:
    "border-fh-border bg-fh-surface text-fh-danger-fg hover:bg-fh-danger-emphasis hover:text-white hover:border-transparent",
  invisible:
    "border-transparent bg-transparent text-fh-accent-fg hover:bg-fh-accent-muted",
};

/**
 * The workhorse button. Variants: primary / default / danger / invisible.
 * Sizes: sm (24px) / md (32px). Pass `loading` to show a spinner and lock it.
 */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "default",
    size = "md",
    loading = false,
    leadingIcon,
    trailingIcon,
    block = false,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(base, sizes[size], variants[variant], block && "w-full", className)}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === "sm" ? 12 : 14} />
      ) : (
        leadingIcon && <span className="inline-flex shrink-0">{leadingIcon}</span>
      )}
      {children != null && <span>{children}</span>}
      {!loading && trailingIcon && <span className="inline-flex shrink-0">{trailingIcon}</span>}
    </button>
  );
});
