import { cx } from "./cx";

type Props = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Large muted icon above the title. */
  icon?: React.ReactNode;
  /** Call-to-action buttons. */
  actions?: React.ReactNode;
  className?: string;
  /** Wrap in a dashed bordered panel (vs. bare centered block). */
  bordered?: boolean;
};

/** Centered placeholder for empty lists / no-results / first-run states. */
export function EmptyState({ title, description, icon, actions, className, bordered = false }: Props) {
  return (
    <div
      className={cx(
        "flex flex-col items-center text-center px-6 py-12",
        bordered && "border border-dashed border-fh-border rounded-md bg-fh-canvas",
        className,
      )}
    >
      {icon && <div className="text-fh-fg-subtle mb-3">{icon}</div>}
      <p className="text-fh-lg font-semibold text-fh-fg">{title}</p>
      {description && <p className="mt-1 text-fh-base text-fh-fg-muted max-w-md">{description}</p>}
      {actions && <div className="mt-4 flex items-center justify-center gap-2">{actions}</div>}
    </div>
  );
}
