import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cx } from "./cx";

type Align = "start" | "end";

type DropdownMenuProps = {
  /** The clickable trigger. Cloned with the required aria/ref wiring. */
  trigger: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  /**
   * Menu content. Pass a render function to make the menu searchable: a filter
   * input is pinned at the top of the panel and the function receives the
   * current query to filter its own rows.
   */
  children: React.ReactNode | ((query: string) => React.ReactNode);
  align?: Align;
  /** Panel width in px (defaults to auto/min-content). */
  width?: number;
  /**
   * Keep the panel open when an item is clicked — for multi-select pickers
   * where several rows are toggled in one visit. Outside-click and Escape
   * still close.
   */
  stayOpen?: boolean;
  /** Placeholder for the search input (function-children menus only). */
  searchPlaceholder?: string;
  className?: string;
};

// Roving focus covers plain items and the checkbox rows multi-select menus use.
const MENUITEM =
  '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"])';

/**
 * Accessible dropdown menu. Handles outside-click, Escape (returns focus to the
 * trigger), and roving arrow-key navigation over its items. Items are the
 * `DropdownItem` / `DropdownSeparator` / `DropdownLabel` exports below.
 *
 * Two opt-in variants (issue #109): function children add a pinned search
 * input (the function receives the query), and `stayOpen` keeps the panel
 * mounted across item clicks for multi-select pickers.
 */
export function DropdownMenu({
  trigger,
  children,
  align = "end",
  width,
  stayOpen = false,
  searchPlaceholder = "Filter…",
  className,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const searchable = typeof children === "function";

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) {
      // triggerRef wraps the trigger in a `contents` span; focus the real control.
      const focusable = triggerRef.current?.querySelector<HTMLElement>(
        'button, a[href], input, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    }
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

  // Focus the search input (searchable) or the first item when the menu opens,
  // and start each visit with a cleared query.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (searchable) {
      searchRef.current?.focus();
      return;
    }
    const items = panelRef.current?.querySelectorAll<HTMLElement>(MENUITEM);
    items?.[0]?.focus();
  }, [open, searchable]);

  function moveFocus(dir: 1 | -1) {
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(MENUITEM) ?? []);
    if (items.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const idx = items.indexOf(current!);
    const next = idx === -1 ? (dir === 1 ? 0 : items.length - 1) : (idx + dir + items.length) % items.length;
    items[next]?.focus();
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    // While typing in the search input, only Escape / ArrowDown / Tab are menu
    // keys — Home/End/ArrowUp keep their text-editing meaning.
    const inSearch = e.target === searchRef.current;
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
        if (inSearch) break;
        e.preventDefault();
        moveFocus(-1);
        break;
      case "Home": {
        if (inSearch) break;
        e.preventDefault();
        const items = panelRef.current?.querySelectorAll<HTMLElement>(MENUITEM);
        items?.[0]?.focus();
        break;
      }
      case "End": {
        if (inSearch) break;
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

  /**
   * Close on panel clicks unless this menu stays open, or the click landed in
   * the search box (focusing/clearing the filter is not a selection).
   */
  function onPanelClick(e: React.MouseEvent) {
    if (stayOpen) return;
    if ((e.target as HTMLElement).closest("[data-menu-search]")) return;
    setOpen(false);
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
          onKeyDown={onPanelKeyDown}
          onClick={onPanelClick}
          className={cx(
            "absolute top-[calc(100%+6px)] z-50 min-w-[180px] py-1",
            "bg-fh-surface border border-fh-border rounded-md shadow-overlay",
            "animate-fh-pop-in origin-top",
            align === "end" ? "right-0" : "left-0",
          )}
          style={{ width }}
        >
          {searchable && (
            <div data-menu-search className="px-2 pb-1 pt-0.5 border-b border-fh-border-muted mb-1">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className={cx(
                  "w-full h-7 px-2 text-fh-sm bg-fh-surface text-fh-fg border border-fh-border rounded-md",
                  "placeholder:text-fh-fg-placeholder outline-none",
                  "focus:border-fh-accent-emphasis focus:shadow-[0_0_0_3px_rgb(var(--fh-accent-emphasis)/0.3)]",
                )}
              />
            </div>
          )}
          {/*
            `role="menu"` belongs to the row list, not the popup shell: a menu may
            only own menuitem-role children, so the search box has to sit outside it
            or screen readers mis-announce it. Searchable lists can get long — cap
            and scroll them; plain menus keep their natural height.
          */}
          <div
            id={menuId}
            role="menu"
            className={searchable ? "max-h-80 overflow-y-auto" : undefined}
          >
            {typeof children === "function" ? children(query) : children}
          </div>
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
