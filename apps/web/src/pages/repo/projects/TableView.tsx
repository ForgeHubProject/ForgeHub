import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Avatar, Badge, DropdownMenu, DropdownItem, LabelChip, cx } from "../../../ui";
import type { ProjectColumn } from "../../../types";
import { ChevronDownIcon } from "../../../ui/icons";
import { KebabIcon, SubjectStateIcon, TrashIcon, subjectHref, subjectRef } from "./parts";

type Props = {
  columns: ProjectColumn[];
  base: string;
  canWrite: boolean;
  onRemoveItem: (itemId: string) => void;
};

type SortKey = "type" | "title" | "state" | "assignee" | "column";

type Row = {
  itemId: string;
  columnName: string;
  type: "issue" | "pull";
  number: number;
  title: string;
  state: string;
  labels: { id: string; name: string; color: string }[];
  assignee: string | null;
  available: boolean;
};

function stateTone(type: string, state: string): "success" | "purple" | "danger" | "neutral" {
  if (state === "merged" || (type === "issue" && state === "closed")) return "purple";
  if (state === "closed") return "danger";
  if (state === "open") return "success";
  return "neutral";
}

export function TableView({ columns, base, canWrite, onRemoveItem }: Props) {
  // Null = natural board order (columns in position order, items within each). A
  // header click switches to an explicit client-side sort.
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

  const rows = useMemo<Row[]>(() => {
    const flat: Row[] = [];
    for (const col of columns) {
      for (const it of col.items) {
        flat.push({
          itemId: it.id,
          columnName: col.name,
          type: it.subject?.type ?? it.subjectType,
          number: it.subject?.number ?? it.subjectNumber,
          title: it.subject?.title ?? "",
          state: it.subject?.state ?? "",
          labels: it.subject?.labels ?? [],
          assignee: it.subject?.assignee ?? null,
          available: it.subject != null,
        });
      }
    }
    if (!sort) return flat;
    const dir = sort.dir === "asc" ? 1 : -1;
    const key = (r: Row): string => {
      switch (sort.key) {
        case "type": return r.type;
        case "title": return r.title.toLowerCase();
        case "state": return r.state;
        case "assignee": return r.assignee ?? "￿"; // unassigned sorts last asc
        case "column": return r.columnName.toLowerCase();
      }
    };
    return [...flat].sort((a, b) => key(a).localeCompare(key(b)) * dir || a.number - b.number);
  }, [columns, sort]);

  function toggleSort(k: SortKey) {
    setSort((s) => (s && s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: "asc" }));
  }

  const headers: { key: SortKey; label: string }[] = [
    { key: "type", label: "Type" },
    { key: "title", label: "Title" },
    { key: "state", label: "State" },
    { key: "column", label: "Column" },
  ];

  return (
    <div className="overflow-x-auto rounded-md border border-fh-border">
      <table className="w-full min-w-[720px] border-collapse text-fh-sm">
        <thead>
          <tr className="border-b border-fh-border bg-fh-surface-muted text-fh-fg-muted">
            {headers.map((h) => (
              <th key={h.key} className="text-left font-semibold px-3 py-2 whitespace-nowrap">
                <SortButton active={sort?.key === h.key} dir={sort?.dir ?? "asc"} onClick={() => toggleSort(h.key)}>
                  {h.label}
                </SortButton>
              </th>
            ))}
            <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Labels</th>
            <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">
              <SortButton active={sort?.key === "assignee"} dir={sort?.dir ?? "asc"} onClick={() => toggleSort("assignee")}>
                Assignee
              </SortButton>
            </th>
            {canWrite && <th className="w-10 px-3 py-2" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemId} className="border-b border-fh-border-muted last:border-0 hover:bg-fh-surface-muted/50">
              <td className="px-3 py-2 align-top">
                {r.available ? (
                  <span className="inline-flex items-center gap-1.5 text-fh-fg-muted">
                    <SubjectStateIcon subject={{ type: r.type, number: r.number, title: r.title, state: r.state, labels: [], assignee: null }} size={14} />
                    {r.type === "pull" ? "PR" : "Issue"}
                  </span>
                ) : (
                  <span className="text-fh-fg-subtle">{r.type === "pull" ? "PR" : "Issue"}</span>
                )}
              </td>
              <td className="px-3 py-2 align-top max-w-[380px]">
                {r.available ? (
                  <Link to={subjectHref(base, r.type, r.number)} className="text-fh-fg hover:text-fh-accent-fg hover:underline font-medium break-words">
                    {r.title}
                  </Link>
                ) : (
                  <span className="italic text-fh-fg-muted">No longer available</span>
                )}
                <span className="ml-1.5 font-mono text-fh-xs text-fh-fg-subtle">{subjectRef(r.type, r.number)}</span>
              </td>
              <td className="px-3 py-2 align-top">
                {r.state ? <Badge tone={stateTone(r.type, r.state)}>{r.state}</Badge> : <span className="text-fh-fg-subtle">—</span>}
              </td>
              <td className="px-3 py-2 align-top whitespace-nowrap text-fh-fg-muted">{r.columnName}</td>
              <td className="px-3 py-2 align-top">
                {r.labels.length > 0 ? (
                  <div className="flex flex-wrap gap-1 max-w-[220px]">
                    {r.labels.map((l) => (<LabelChip key={l.id} name={l.name} color={l.color} />))}
                  </div>
                ) : (
                  <span className="text-fh-fg-subtle">—</span>
                )}
              </td>
              <td className="px-3 py-2 align-top">
                {r.assignee ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar name={r.assignee} size={18} /> <span className="text-fh-fg-muted">{r.assignee}</span>
                  </span>
                ) : (
                  <span className="text-fh-fg-subtle">—</span>
                )}
              </td>
              {canWrite && (
                <td className="px-3 py-2 align-top text-right">
                  <DropdownMenu
                    align="end"
                    trigger={
                      <button type="button" aria-label="Item actions" className="inline-flex items-center justify-center h-6 w-6 rounded-md text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis">
                        <KebabIcon size={16} />
                      </button>
                    }
                  >
                    <DropdownItem danger leadingIcon={<TrashIcon size={14} />} onSelect={() => onRemoveItem(r.itemId)}>
                      Remove from project
                    </DropdownItem>
                  </DropdownMenu>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortButton({ active, dir, onClick, children }: { active: boolean; dir: "asc" | "desc"; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis rounded",
        active ? "text-fh-fg" : "hover:text-fh-fg",
      )}
    >
      {children}
      <ChevronDownIcon
        size={12}
        className={cx("transition-transform", active ? "opacity-100" : "opacity-0", dir === "asc" && "rotate-180")}
      />
    </button>
  );
}
