import { useEffect, useRef, useState } from "react";
import { Avatar, cx, LabelChip } from "../../../ui";
import { CheckIcon, ChevronDownIcon } from "../../../ui/icons";
import { GearIcon } from "./icons";
import type { Label } from "../../../types";
import type { RepoMember } from "../../../api";

/**
 * A muted filter-bar trigger button: label + chevron. Used as the `trigger` for
 * the single-select `DropdownMenu` filters, styled to sit quietly in the list
 * header rather than compete with the primary action.
 */
export function FilterTrigger({
  label,
  active,
  icon,
}: {
  label: React.ReactNode;
  active?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-fh-sm font-medium",
        "transition-colors hover:bg-fh-surface-muted",
        active ? "text-fh-fg" : "text-fh-fg-muted hover:text-fh-fg",
      )}
    >
      {icon && <span className="inline-flex shrink-0 text-fh-fg-subtle">{icon}</span>}
      {label}
      <ChevronDownIcon size={12} className="text-fh-fg-subtle" />
    </button>
  );
}

/**
 * A lightweight popover that — unlike the shared `DropdownMenu` — stays open
 * while you interact with it, so multiple labels can be toggled in one visit.
 * Closes on outside-click and Escape.
 */
export function Popover({
  trigger,
  children,
  align = "end",
  width = 224,
}: {
  trigger: (open: boolean, toggle: () => void) => React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "end";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          className={cx(
            "absolute top-[calc(100%+6px)] z-50 max-h-80 overflow-y-auto py-1",
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

/** A sidebar section header: uppercase title + an optional gear edit trigger. */
export function SidebarHeader({
  title,
  onEdit,
}: {
  title: string;
  onEdit?: () => void;
}) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-fh-sm font-semibold text-fh-fg">{title}</h3>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${title.toLowerCase()}`}
          className="p-1 -m-1 rounded text-fh-fg-muted hover:text-fh-fg transition-colors"
        >
          <GearIcon size={16} />
        </button>
      )}
    </div>
  );
}

/** A selectable label row for the multi-select label popover. Stays put on click. */
export function LabelOptionRow({
  label,
  checked,
  onToggle,
}: {
  label: Label;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-fh-surface-muted transition-colors"
    >
      <span className="w-4 shrink-0 text-fh-accent-fg">
        {checked && <CheckIcon size={14} />}
      </span>
      <LabelChip name={label.name} color={label.color} />
      {label.description && (
        <span className="ml-auto pl-2 text-fh-xs text-fh-fg-subtle truncate">{label.description}</span>
      )}
    </button>
  );
}

/** A selectable member row for the assignee popover. */
export function MemberOptionRow({
  member,
  checked,
  onToggle,
}: {
  member: RepoMember;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-fh-surface-muted transition-colors"
    >
      <span className="w-4 shrink-0 text-fh-accent-fg">
        {checked && <CheckIcon size={14} />}
      </span>
      <Avatar name={member.displayName ?? member.handle} size={20} />
      <span className="min-w-0 truncate text-fh-sm text-fh-fg">{member.handle}</span>
    </button>
  );
}
