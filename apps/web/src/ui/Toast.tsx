import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { CheckIcon, XIcon } from "./icons";

export type ToastTone = "info" | "success" | "danger" | "warning";

export type ToastOptions = {
  tone?: ToastTone;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. Default 4000. */
  duration?: number;
};

type Toast = {
  id: number;
  message: React.ReactNode;
  tone: ToastTone;
};

type ToastContextValue = {
  /** Show a toast; returns its id so callers can dismiss it early. */
  toast: (message: React.ReactNode, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const toneStyles: Record<ToastTone, string> = {
  info: "border-fh-border",
  success: "border-fh-success-emphasis/40",
  danger: "border-fh-danger-emphasis/40",
  warning: "border-fh-warning-emphasis/40",
};

const toneAccent: Record<ToastTone, string> = {
  info: "text-fh-accent-fg",
  success: "text-fh-success-fg",
  danger: "text-fh-danger-fg",
  warning: "text-fh-warning-fg",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: React.ReactNode, opts: ToastOptions = {}) => {
      const id = nextId.current++;
      const tone = opts.tone ?? "info";
      setToasts((list) => [...list, { id, message, tone }]);
      const duration = opts.duration ?? 4000;
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="fixed bottom-4 right-4 z-[120] flex flex-col gap-2 w-[min(360px,calc(100vw-2rem))]" aria-live="polite" role="region">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="alert"
              className={cx(
                "flex items-start gap-2 rounded-md border bg-fh-surface px-3 py-2.5 shadow-overlay animate-fh-toast-in",
                toneStyles[t.tone],
              )}
            >
              <span className={cx("mt-0.5 shrink-0", toneAccent[t.tone])}>
                {t.tone === "success" ? <CheckIcon size={16} /> : <ToastDot />}
              </span>
              <span className="flex-1 min-w-0 text-fh-sm text-fh-fg leading-snug">{t.message}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="shrink-0 -mr-1 p-0.5 rounded text-fh-fg-subtle hover:text-fh-fg bg-transparent border-none cursor-pointer"
              >
                <XIcon size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastDot() {
  return <span className="inline-block w-2 h-2 rounded-full bg-current" aria-hidden />;
}

/** Access the toast dispatcher. Must be used within a `ToastProvider`. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
