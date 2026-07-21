import { Fragment } from "react";
import { Link } from "react-router-dom";
import { cx } from "./cx";

export type Crumb = {
  label: React.ReactNode;
  to?: string;
};

type Props = {
  items: Crumb[];
  className?: string;
  /** Style the final crumb as bold (repo-page convention). */
  emphasizeLast?: boolean;
};

/**
 * Slash-separated breadcrumb trail. Items with `to` are links; the last item is
 * rendered as the current location (no link).
 */
export function Breadcrumbs({ items, className, emphasizeLast = true }: Props) {
  return (
    <nav aria-label="Breadcrumb" className={cx("flex items-center flex-wrap gap-1 text-fh-lg min-w-0", className)}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={i}>
            {item.to && !last ? (
              <Link to={item.to} className="text-fh-accent-fg hover:underline truncate">
                {item.label}
              </Link>
            ) : (
              <span
                aria-current={last ? "page" : undefined}
                className={cx("truncate", last && emphasizeLast ? "font-semibold text-fh-fg" : "text-fh-fg-muted")}
              >
                {item.label}
              </span>
            )}
            {!last && <span className="text-fh-fg-subtle select-none">/</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
