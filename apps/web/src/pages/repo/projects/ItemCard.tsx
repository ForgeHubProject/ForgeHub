import { Link } from "react-router-dom";
import { Avatar, DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator, LabelChip, cx } from "../../../ui";
import type { ProjectColumn, ProjectItem } from "../../../types";
import { GripIcon, KebabIcon, SubjectStateIcon, TrashIcon, subjectHref, subjectRef } from "./parts";

type Props = {
  item: ProjectItem;
  base: string;
  columns: ProjectColumn[];
  currentColumnId: string;
  canWrite: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Move to the end of another column (keyboard-accessible DnD fallback). */
  onMoveToColumn: (destColumnId: string) => void;
  onRemove: () => void;
};

/** A single board card: subject state glyph, title, ref, labels, assignee, kebab. */
export function ItemCard({
  item, base, columns, currentColumnId, canWrite, dragging, onDragStart, onDragEnd, onMoveToColumn, onRemove,
}: Props) {
  const { subject } = item;
  const otherColumns = columns.filter((c) => c.id !== currentColumnId);

  return (
    <div
      draggable={canWrite}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-item-id={item.id}
      className={cx(
        "group relative rounded-md border border-fh-border bg-fh-surface px-3 py-2.5 text-fh-sm",
        "shadow-none transition-colors",
        canWrite && "cursor-grab hover:border-fh-border-strong active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      {subject ? (
        <>
          <div className="flex items-start gap-2">
            <span className="mt-0.5">
              <SubjectStateIcon subject={subject} />
            </span>
            <div className="min-w-0 flex-1">
              <Link
                to={subjectHref(base, subject.type, subject.number)}
                onClick={(e) => e.stopPropagation()}
                draggable={false}
                className="font-medium text-fh-fg hover:text-fh-accent-fg hover:underline break-words leading-snug"
              >
                {subject.title}
              </Link>
              <div className="mt-0.5 text-fh-xs font-mono text-fh-fg-subtle">{subjectRef(subject.type, subject.number)}</div>
            </div>
            {canWrite && (
              <span className="shrink-0 -mr-1 flex items-center">
                <span className="hidden group-hover:inline-flex text-fh-fg-subtle mr-0.5" aria-hidden="true">
                  <GripIcon size={14} />
                </span>
                <DropdownMenu
                  align="end"
                  trigger={
                    <button
                      type="button"
                      aria-label="Card actions"
                      className="inline-flex items-center justify-center h-6 w-6 rounded-md text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis"
                    >
                      <KebabIcon size={16} />
                    </button>
                  }
                >
                  {otherColumns.length > 0 && <DropdownLabel>Move to</DropdownLabel>}
                  {otherColumns.map((c) => (
                    <DropdownItem key={c.id} onSelect={() => onMoveToColumn(c.id)}>
                      {c.name}
                    </DropdownItem>
                  ))}
                  {otherColumns.length > 0 && <DropdownSeparator />}
                  <DropdownItem danger leadingIcon={<TrashIcon size={14} />} onSelect={onRemove}>
                    Remove from project
                  </DropdownItem>
                </DropdownMenu>
              </span>
            )}
          </div>

          {subject.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {subject.labels.map((l) => (
                <LabelChip key={l.id} name={l.name} color={l.color} />
              ))}
            </div>
          )}

          {subject.assignee && (
            <div className="mt-2 flex justify-end">
              <Avatar name={subject.assignee} size={20} />
            </div>
          )}
        </>
      ) : (
        // Subject was deleted after being added — degrade gracefully.
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-fh-fg-muted italic">This {item.subjectType === "pull" ? "pull request" : "issue"} is no longer available</p>
            <div className="mt-0.5 text-fh-xs font-mono text-fh-fg-subtle">{subjectRef(item.subjectType, item.subjectNumber)}</div>
          </div>
          {canWrite && (
            <button
              type="button"
              aria-label="Remove from project"
              onClick={onRemove}
              className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md text-fh-fg-muted hover:bg-fh-danger-muted hover:text-fh-danger-fg outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis"
            >
              <TrashIcon size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
