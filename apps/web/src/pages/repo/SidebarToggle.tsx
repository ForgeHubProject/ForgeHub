import { Tooltip } from "../../ui";

function SidebarGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M6.823 7.823a.25.25 0 0 1 0 .354l-2.396 2.396A.25.25 0 0 1 4 10.396V5.604a.25.25 0 0 1 .427-.177ZM1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0ZM1.5 1.75v12.5c0 .138.112.25.25.25H9.5v-13H1.75a.25.25 0 0 0-.25.25ZM11 14.5h3.25a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H11Z" />
    </svg>
  );
}

/** The show/hide button for a page's file tree pane (commit page, file page). */
export function SidebarToggle({ shown, onToggle }: { shown: boolean; onToggle: (shown: boolean) => void }) {
  const label = shown ? "Hide file tree" : "Show file tree";
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={() => onToggle(!shown)}
        aria-pressed={shown}
        aria-label={label}
        className="inline-flex items-center justify-center rounded-md border border-fh-border bg-fh-surface p-1.5 text-fh-fg-muted hover:text-fh-fg hover:border-fh-border-strong cursor-pointer"
      >
        <SidebarGlyph />
      </button>
    </Tooltip>
  );
}
