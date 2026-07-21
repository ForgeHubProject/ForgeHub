import { cx } from "./cx";

type Props = {
  title: React.ReactNode;
  /** Leading icon, sized to the title. */
  icon?: React.ReactNode;
  /** Secondary text / metadata under the title. */
  description?: React.ReactNode;
  /** Right-aligned actions (buttons, etc.). */
  actions?: React.ReactNode;
  /** Content rendered below the heading row, above any divider. */
  children?: React.ReactNode;
  divider?: boolean;
  className?: string;
};

/** Standard page/section heading: title + optional description and actions. */
export function PageHeading({ title, icon, description, actions, children, divider = false, className }: Props) {
  return (
    <div className={cx(divider && "border-b border-fh-border pb-4 mb-4", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-fh-2xl font-semibold text-fh-fg">
            {icon && <span className="inline-flex shrink-0 text-fh-fg-muted">{icon}</span>}
            <span className="truncate">{title}</span>
          </h1>
          {description && <p className="mt-1 text-fh-base text-fh-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
