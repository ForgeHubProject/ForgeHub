import { useId, useState } from "react";
import { cx } from "./cx";

type Placement = "top" | "bottom" | "left" | "right";

type Props = {
  label: React.ReactNode;
  children: React.ReactElement;
  placement?: Placement;
  className?: string;
};

const placementCls: Record<Placement, string> = {
  top: "bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2",
  bottom: "top-[calc(100%+6px)] left-1/2 -translate-x-1/2",
  left: "right-[calc(100%+6px)] top-1/2 -translate-y-1/2",
  right: "left-[calc(100%+6px)] top-1/2 -translate-y-1/2",
};

/**
 * Lightweight CSS tooltip shown on hover/focus. Wraps a single element and
 * describes it via aria-describedby. For plain string hints prefer the native
 * `title` attribute; use this when you need styled/rich content.
 */
export function Tooltip({ label, children, placement = "top", className }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="contents">
        {children}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cx(
            "absolute z-[110] whitespace-nowrap rounded px-2 py-1 text-fh-xs font-medium pointer-events-none",
            "bg-fh-header-bg text-fh-header-text shadow-overlay animate-fh-fade-in",
            placementCls[placement],
            className,
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}
