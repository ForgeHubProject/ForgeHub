import { useState } from "react";
import { Avatar, Button, cx, LabelChip, TextInput } from "../../../ui";
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

// ─── Time tracking (issue #122) ─────────────────────────────────────────────────
// GitLab-style estimate vs. spent, mirrored client-side so the sidebar can accept
// durations like "2h30m". Semantics match apps/api/src/duration.ts: 1w=5d, 1d=8h.

const UNIT_MINUTES: Record<"w" | "d" | "h" | "m", number> = { m: 1, h: 60, d: 8 * 60, w: 5 * 8 * 60 };

/** Parse a duration string (`2h30m`, `1d`, `1w`) into whole minutes, or null. */
export function parseDurationInput(input: string): number | null {
  const compact = input.trim().toLowerCase().replace(/\s+/g, "");
  if (compact === "" || !/^(?:\d+(?:w|d|h|m))+$/.test(compact)) return null;
  let total = 0;
  for (const m of compact.matchAll(/(\d+)(w|d|h|m)/g)) {
    total += Number(m[1]) * UNIT_MINUTES[m[2] as "w" | "d" | "h" | "m"];
  }
  return total;
}

/** Render whole minutes as a compact `1d 2h 30m` string; 0 → "0m". */
export function formatMinutes(mins: number): string {
  if (mins <= 0) return "0m";
  let rem = mins;
  const parts: string[] = [];
  for (const unit of ["w", "d", "h", "m"] as const) {
    const n = Math.floor(rem / UNIT_MINUTES[unit]);
    if (n > 0) { parts.push(`${n}${unit}`); rem -= n * UNIT_MINUTES[unit]; }
  }
  return parts.join(" ");
}

/** A single labelled duration editor row inside the time-tracking popover. */
function TimeField({
  label,
  minutes,
  onSave,
}: {
  label: string;
  minutes: number;
  onSave: (minutes: number) => void;
}) {
  const [draft, setDraft] = useState(minutes > 0 ? formatMinutes(minutes) : "");
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") { onSave(0); setError(null); return; } // empty clears
    const parsed = parseDurationInput(trimmed);
    if (parsed == null) { setError("Use a duration like 2h30m, 1d, 1w"); return; }
    setError(null);
    onSave(parsed);
  }

  return (
    <div className="px-3 py-2">
      <label className="block text-fh-xs font-semibold text-fh-fg-muted mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <TextInput
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 2h30m"
          className="text-fh-sm"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        />
        <Button variant="default" size="sm" onClick={commit}>Set</Button>
      </div>
      {error && <p className="mt-1 text-fh-xs text-fh-danger-fg">{error}</p>}
    </div>
  );
}

/**
 * Time-tracking sidebar section: estimate vs. spent with a thin progress bar.
 * Presentational — the parent owns persistence via the `onSet*` callbacks (0
 * clears). Only writers see the editor, matching the REST endpoints' gate.
 */
export function SidebarTimeTracking({
  estimateMinutes,
  spentMinutes,
  canEdit,
  onSetEstimate,
  onSetSpent,
}: {
  estimateMinutes: number;
  spentMinutes: number;
  canEdit: boolean;
  onSetEstimate: (minutes: number) => void;
  onSetSpent: (minutes: number) => void;
}) {
  const hasAny = estimateMinutes > 0 || spentMinutes > 0;
  const over = estimateMinutes > 0 && spentMinutes > estimateMinutes;
  const pct =
    estimateMinutes > 0 ? Math.min(100, Math.round((spentMinutes / estimateMinutes) * 100))
    : spentMinutes > 0 ? 100
    : 0;
  const remaining = estimateMinutes - spentMinutes;

  return (
    <section className="pb-4 mb-4 border-b border-fh-border-muted">
      {canEdit ? (
        <Popover align="start" trigger={(_open, toggle) => <SidebarHeader title="Time tracking" onEdit={toggle} />}>
          <TimeField label="Estimate" minutes={estimateMinutes} onSave={onSetEstimate} />
          <TimeField label="Time spent (total)" minutes={spentMinutes} onSave={onSetSpent} />
          <p className="px-3 pt-1 pb-2 text-fh-xs text-fh-fg-subtle">
            Leave a field empty to clear it. In a comment, use{" "}
            <code className="text-fh-fg-muted">/estimate</code> and{" "}
            <code className="text-fh-fg-muted">/spend</code>.
          </p>
        </Popover>
      ) : (
        <SidebarHeader title="Time tracking" />
      )}

      <div className="mt-2">
        {!hasAny ? (
          <p className="text-fh-sm text-fh-fg-muted">No estimate or time logged</p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-fh-sm">
              <span className="text-fh-fg-muted">Spent</span>
              <span className="text-fh-fg font-medium">{formatMinutes(spentMinutes)}</span>
            </div>
            <div
              className="h-1.5 w-full rounded-full bg-fh-border overflow-hidden"
              role="progressbar"
              aria-valuenow={spentMinutes}
              aria-valuemin={0}
              aria-valuemax={estimateMinutes || spentMinutes}
            >
              <div
                className={cx("h-full rounded-full transition-all", over ? "bg-fh-danger-emphasis" : "bg-fh-accent-emphasis")}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-fh-xs text-fh-fg-subtle">
              <span>Estimate {estimateMinutes > 0 ? formatMinutes(estimateMinutes) : "—"}</span>
              {estimateMinutes > 0 && (
                <span className={cx(over ? "text-fh-danger-fg" : "text-fh-fg-subtle")}>
                  {over ? `${formatMinutes(-remaining)} over` : `${formatMinutes(remaining)} left`}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
