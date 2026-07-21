import { Link } from "react-router-dom";
import { cx } from "./cx";

type TabNavProps = {
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
};

/** Horizontal tab bar with a hairline underline. Fill with `TabItem`s. */
export function TabNav({ children, className, ...rest }: TabNavProps) {
  return (
    <nav
      role="tablist"
      className={cx("flex items-stretch gap-1 border-b border-fh-border overflow-x-auto", className)}
      {...rest}
    >
      {children}
    </nav>
  );
}

type TabItemProps = {
  active?: boolean;
  icon?: React.ReactNode;
  /** Muted counter pill shown after the label. */
  count?: number;
  children: React.ReactNode;
  /** Render as a router link. */
  to?: string;
  onClick?: () => void;
  className?: string;
};

/**
 * One tab: icon + label + optional counter pill, with a 2px accent underline
 * when active. Renders as a router `Link` when `to` is set, else a button.
 */
export function TabItem({ active, icon, count, children, to, onClick, className }: TabItemProps) {
  const inner = (
    <>
      {icon && <span className={cx("inline-flex shrink-0", active ? "text-fh-fg" : "text-fh-fg-muted")}>{icon}</span>}
      <span>{children}</span>
      {count != null && (
        <span
          className={cx(
            "inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full text-fh-xs font-semibold",
            active ? "bg-fh-neutral-muted text-fh-fg" : "bg-fh-neutral-muted text-fh-fg-muted",
          )}
        >
          {count}
        </span>
      )}
    </>
  );

  const cls = cx(
    "flex items-center gap-1.5 px-3 py-2 text-fh-base whitespace-nowrap",
    "border-b-2 -mb-px transition-colors duration-100 cursor-pointer",
    active
      ? "text-fh-fg font-semibold border-fh-accent-emphasis"
      : "text-fh-fg-muted border-transparent hover:text-fh-fg hover:border-fh-border-strong",
    className,
  );

  if (to) {
    return (
      <Link to={to} role="tab" aria-selected={active} className={cls} onClick={onClick}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={cx(cls, "bg-transparent border-t-0 border-x-0")}>
      {inner}
    </button>
  );
}
