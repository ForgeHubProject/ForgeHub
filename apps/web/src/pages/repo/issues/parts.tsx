import { Link } from "react-router-dom";
import { cx } from "../../../ui";
import { IssueOpenedIcon, IssueClosedIcon } from "./icons";

/** The list/detail leading state glyph in its token color. */
export function StateIcon({ state, size = 16 }: { state: "open" | "closed"; size?: number }) {
  return state === "open" ? (
    <IssueOpenedIcon size={size} className="text-fh-success-fg" />
  ) : (
    <IssueClosedIcon size={size} className="text-fh-purple-fg" />
  );
}

/** The solid GitHub-style state pill for the issue detail header. */
export function StatePill({ state }: { state: "open" | "closed" }) {
  const open = state === "open";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-fh-base font-medium text-white",
        open ? "bg-fh-success-emphasis" : "bg-fh-purple-emphasis",
      )}
    >
      <StateIcon state={state} />
      {open ? "Open" : "Closed"}
    </span>
  );
}

/** A repo-handle link that reads as a person, stopping row-click propagation. */
export function UserLink({ handle, className }: { handle: string; className?: string }) {
  return (
    <Link
      to={`/${handle}`}
      onClick={(e) => e.stopPropagation()}
      className={cx("font-semibold text-fh-fg hover:text-fh-accent-fg hover:underline", className)}
    >
      {handle}
    </Link>
  );
}
