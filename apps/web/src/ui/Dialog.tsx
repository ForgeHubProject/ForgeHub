import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { XIcon } from "./icons";

type DialogSize = "sm" | "md" | "lg";

type Props = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Footer actions, right-aligned. */
  footer?: React.ReactNode;
  size?: DialogSize;
  /** Hide the header close button (Escape / backdrop still close). */
  hideClose?: boolean;
};

const sizes: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

/**
 * Accessible modal dialog rendered in a portal. Closes on Escape and backdrop
 * click, traps initial focus, restores focus to the previously focused element,
 * and locks body scroll while open.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md", hideClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Focus the first focusable element, or the panel itself.
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusables && focusables.length ? focusables[0] : panelRef.current)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        // Simple focus trap.
        const items = panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!items || items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:pt-[10vh] bg-black/50 animate-fh-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          "w-full bg-fh-surface border border-fh-border rounded-md shadow-overlay outline-none animate-fh-pop-in",
          sizes[size],
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-fh-border">
            <div className="min-w-0">
              {title && (
                <h2 id={titleId} className="text-fh-lg font-semibold text-fh-fg">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="text-fh-sm text-fh-fg-muted mt-0.5">
                  {description}
                </p>
              )}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 -mr-1 p-1 rounded-md text-fh-fg-muted hover:text-fh-fg hover:bg-fh-surface-muted cursor-pointer bg-transparent border-none"
              >
                <XIcon />
              </button>
            )}
          </div>
        )}
        {children != null && <div className="px-4 py-4 text-fh-base text-fh-fg">{children}</div>}
        {footer && <div className="flex justify-end gap-2 px-4 py-3 border-t border-fh-border">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
