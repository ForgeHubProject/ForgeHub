import { useId } from "react";
import { cx } from "../../ui";

/**
 * One block of the Code tab's sidebar (issue #208): a heading, an optional
 * counter or action on its right, and a hairline between blocks — GitHub's
 * About / Releases / Languages anatomy, in tokens.
 */
export function SidebarSection({
  title,
  count,
  action,
  children,
  className,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx("py-4 border-t border-fh-border first:border-t-0 first:pt-0", className)}>
      <div className="mb-2.5 flex items-center gap-2">
        <h2 id={id} className="text-fh-base font-semibold text-fh-fg">
          {title}
        </h2>
        {count != null && (
          <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full bg-fh-neutral-muted px-1.5 text-fh-xs font-semibold text-fh-fg-muted">
            {count}
          </span>
        )}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}
