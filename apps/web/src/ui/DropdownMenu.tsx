import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cx } from "./cx";

type Align = "start" | "end";

type DropdownMenuProps = {
  /** The clickable trigger. Cloned with the required aria/ref wiring. */
  trigger: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  children: React.ReactNode;
  align?: Align;
  /** Panel width in px (defaults to auto/min-content). */
  width?: number;
  className?: string;
};

const MENUITEM = '[role="menuitem"]:not([aria-disabled="true"])';

/**
 * Accessible dropdown menu. Handles outside-click, Escape (returns focus to the
 * trigger), and roving arrow-key navigation over its items. Items are the
 * `DropdownItem` / `DropdownSeparator` / `DropdownLabel` exports below.
 */
export function DropdownMenu({ trigger, children, align = "end", width, className }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const menuId = useId();

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Outside click / focus loss.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (!open) return;
    const items = panelRef.current?.querySelectorAll<HTMLElement>(MENUITEM);
    items?.[0]?.focus();
  }, [open]);

  function moveFocus(dir: 1 | -1) {
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(MENUITEM) ?? []);
    if (items.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const idx = items.indexOf(current!);
    const next = idx === -1 ? (dir === 1 ? 0 : items.length - 1) : (idx + dir + items.length) % items.length;
    items[next]?.focus();
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "Home": {
        e.preventDefault();
        const items = panelRef.current?.querySelectorAll<HTMLElement>(MENUITEM);
        items?.[0]?.focus();
        break;
      }
      case "End": {
        e.preventDefault();
        const items = panelRef.current?.querySelectorAll<HTMLElement>(MENUITEM);
        items?.[items.length - 1]?.focus();
        break;
      }
      case "Tab":
        setOpen(false);
        break;
    }
  }

  const triggerEl = trigger as React.ReactElement<Record<string, unknown>>;
  const clonedTrigger = (
    <span ref={triggerRef as React.RefObject<HTMLSpanElement>} className="contents">
      {/* Wrap so we can toggle without depending on the trigger forwarding refs. */}
      <span
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="contents"
      >
        {triggerEl}
      </span>
    </span>
  );

  return (
    <div ref={rootRef} className={cx("relative inline-block", className)}>
      <span aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}>
        {clonedTrigger}
      </span>
      {open && (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          onKeyDown={onPanelKeyDown}
          onClick={() => setOpen(false)}
          className={cx(
            "absolute top-[calc(100%+6px)] z-50 min-w-[180px] py-1",
            "bg-fh-surface border border-fh-border rounded-md shadow-overlay",
            "animate-fh-pop-in origin-top",
            align === "end" ? "right-0" : "left-0",
          )}
          style={{ width }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

type DropdownItemProps = {
  children: React.ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  leadingIcon?: React.ReactNode;
  trailing?: React.ReactNode;
};

/** A selectable menu row. Use `onSelect` for the action. */
export function DropdownItem({ children, onSelect, disabled, danger, leadingIcon, trailing }: DropdownItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => !disabled && onSelect?.()}
      className={cx(
        "w-full flex items-center gap-2 px-3 py-1.5 text-fh-sm text-left bg-transparent border-none cursor-pointer",
        "outline-none focus:bg-fh-accent-muted focus:text-fh-accent-fg hover:bg-fh-accent-muted hover:text-fh-accent-fg",
        danger && "text-fh-danger-fg focus:bg-fh-danger-muted hover:bg-fh-danger-muted focus:text-fh-danger-fg hover:text-fh-danger-fg",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
        !danger && !disabled && "text-fh-fg",
      )}
    >
      {leadingIcon && <span className="inline-flex shrink-0 text-fh-fg-muted">{leadingIcon}</span>}
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {trailing && <span className="ml-auto shrink-0 text-fh-fg-muted">{trailing}</span>}
    </button>
  );
}

export function DropdownSeparator() {
  return <div role="separator" className="my-1 h-px bg-fh-border-muted" />;
}

export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-1 text-fh-xs font-semibold text-fh-fg-subtle uppercase tracking-wide">{children}</div>;
}
