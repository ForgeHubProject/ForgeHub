import { Avatar, LabelChip } from "../../../ui";
import { XIcon } from "../../../ui/icons";
import type { Label } from "../../../types";
import type { RepoMember } from "../../../api";
import { LabelOptionRow, MemberOptionRow, Popover, SidebarHeader } from "./pickers";

/**
 * Labels sidebar section. Presentational: the parent owns `selected` and decides
 * whether toggling persists to the API (detail) or stays local (composer).
 */
export function SidebarLabels({
  allLabels,
  selected,
  onToggle,
  canEdit,
}: {
  allLabels: Label[];
  selected: Label[];
  onToggle: (label: Label) => void;
  canEdit: boolean;
}) {
  const selectedIds = new Set(selected.map((l) => l.id));

  const chips =
    selected.length === 0 ? (
      <p className="text-fh-sm text-fh-fg-muted">None yet</p>
    ) : (
      <div className="flex flex-wrap gap-1">
        {selected.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-0.5">
            <LabelChip name={l.name} color={l.color} />
            {canEdit && (
              <button
                type="button"
                onClick={() => onToggle(l)}
                aria-label={`Remove ${l.name} label`}
                className="text-fh-fg-subtle hover:text-fh-danger-fg transition-colors"
              >
                <XIcon size={12} />
              </button>
            )}
          </span>
        ))}
      </div>
    );

  return (
    <section className="pb-4 mb-4 border-b border-fh-border-muted">
      {canEdit ? (
        <Popover
          align="start"
          trigger={(_open, toggle) => <SidebarHeader title="Labels" onEdit={toggle} />}
        >
          {allLabels.length === 0 ? (
            <p className="px-3 py-2 text-fh-sm text-fh-fg-muted">
              No labels yet. Create them in Settings.
            </p>
          ) : (
            allLabels.map((l) => (
              <LabelOptionRow key={l.id} label={l} checked={selectedIds.has(l.id)} onToggle={() => onToggle(l)} />
            ))
          )}
        </Popover>
      ) : (
        <SidebarHeader title="Labels" />
      )}
      <div className="mt-2">{chips}</div>
    </section>
  );
}

/**
 * Assignee sidebar section (single assignee). Clicking the current assignee
 * again clears it.
 */
export function SidebarAssignee({
  members,
  selectedHandle,
  onSelect,
  canEdit,
}: {
  members: RepoMember[];
  selectedHandle: string | null;
  onSelect: (handle: string | null) => void;
  canEdit: boolean;
}) {
  const applied =
    selectedHandle ? (
      <div className="flex items-center gap-2">
        <Avatar name={selectedHandle} size={20} />
        <span className="text-fh-sm text-fh-fg">{selectedHandle}</span>
      </div>
    ) : (
      <p className="text-fh-sm text-fh-fg-muted">No one assigned</p>
    );

  return (
    <section className="pb-4 mb-4 border-b border-fh-border-muted">
      {canEdit ? (
        <Popover
          align="start"
          trigger={(_open, toggle) => <SidebarHeader title="Assignee" onEdit={toggle} />}
        >
          {members.length === 0 ? (
            <p className="px-3 py-2 text-fh-sm text-fh-fg-muted">No members to assign.</p>
          ) : (
            members.map((m) => (
              <MemberOptionRow
                key={m.id}
                member={m}
                checked={selectedHandle === m.handle}
                onToggle={() => onSelect(selectedHandle === m.handle ? null : m.handle)}
              />
            ))
          )}
        </Popover>
      ) : (
        <SidebarHeader title="Assignee" />
      )}
      <div className="mt-2">{applied}</div>
    </section>
  );
}
