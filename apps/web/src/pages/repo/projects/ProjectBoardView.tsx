import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  addProjectItem, createProjectColumn, deleteProject, deleteProjectColumn, getProject,
  moveProjectItem, removeProjectItem, renameProjectColumn, reorderProjectColumns, updateProject,
} from "../../../api";
import {
  Badge, Button, ConfirmDialog, Dialog, DropdownMenu, DropdownItem, DropdownSeparator,
  EmptyState, Field, Spinner, TextInput, Textarea, cx, useToast,
} from "../../../ui";
import type { ProjectColumn, ProjectDetail, ProjectItem, ProjectSubjectType } from "../../../types";
import { BoardView } from "./BoardView";
import { TableView } from "./TableView";
import { BoardIcon, KebabIcon, PencilIcon, ProjectIcon, TableIcon, TrashIcon } from "./parts";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  base: string;
  projectNumber: number;
  canWrite: boolean;
  onChanged?: () => void;
};

type ViewMode = "board" | "table";

/** Insert/remove/move helpers over the columns array (pure, for optimistic updates). */
function applyMove(cols: ProjectColumn[], itemId: string, destColumnId: string, index: number): ProjectColumn[] {
  let moved: ProjectItem | undefined;
  const stripped = cols.map((c) => ({
    ...c,
    items: c.items.filter((it) => {
      if (it.id === itemId) { moved = it; return false; }
      return true;
    }),
  }));
  if (!moved) return cols;
  return stripped.map((c) => {
    if (c.id !== destColumnId) return c;
    const items = [...c.items];
    const i = Math.max(0, Math.min(index, items.length));
    items.splice(i, 0, { ...moved!, columnId: destColumnId });
    return { ...c, items };
  });
}

export function ProjectBoardView({ token, handle, repoName, base, projectNumber, canWrite, onChanged }: Props) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [columns, setColumns] = useState<ProjectColumn[]>([]);
  // View mode lives in the URL (`?view=table`) so it's shareable and bookmarkable.
  const view: ViewMode = searchParams.get("view") === "table" ? "table" : "board";
  function setView(v: ViewMode) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (v === "board") p.delete("view");
        else p.set("view", v);
        return p;
      },
      { replace: true },
    );
  }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getProject(token, handle, repoName, projectNumber)
      .then((p) => { setProject(p); setColumns(p.columns); })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load project"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, projectNumber]);

  const itemCount = columns.reduce((n, c) => n + c.items.length, 0);

  // ─── Mutations (optimistic where it helps; rollback + toast on failure) ───────

  function moveItem(itemId: string, destColumnId: string, index: number) {
    const prev = columns;
    setColumns(applyMove(prev, itemId, destColumnId, index));
    moveProjectItem(token, handle, repoName, projectNumber, itemId, destColumnId, index).catch(() => {
      setColumns(prev);
      toast("Couldn't move the card", { tone: "danger" });
    });
  }

  async function addItem(columnId: string, type: ProjectSubjectType, number: number) {
    try {
      const item = await addProjectItem(token, handle, repoName, projectNumber, columnId, type, number);
      setColumns((prev) => prev.map((c) => (c.id === columnId ? { ...c, items: [...c.items, item] } : c)));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't add the item", { tone: "danger" });
      throw e;
    }
  }

  function removeItem(itemId: string) {
    const prev = columns;
    setColumns(prev.map((c) => ({ ...c, items: c.items.filter((it) => it.id !== itemId) })));
    removeProjectItem(token, handle, repoName, projectNumber, itemId).catch(() => {
      setColumns(prev);
      toast("Couldn't remove the item", { tone: "danger" });
    });
  }

  async function addColumn(name: string) {
    try {
      const col = await createProjectColumn(token, handle, repoName, projectNumber, name);
      setColumns((prev) => [...prev, { ...col, items: col.items ?? [] }]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't add the column", { tone: "danger" });
    }
  }

  async function renameColumn(columnId: string, name: string) {
    const prev = columns;
    setColumns(prev.map((c) => (c.id === columnId ? { ...c, name } : c)));
    try {
      await renameProjectColumn(token, handle, repoName, projectNumber, columnId, name);
    } catch {
      setColumns(prev);
      toast("Couldn't rename the column", { tone: "danger" });
    }
  }

  function deleteColumn(columnId: string) {
    const prev = columns;
    setColumns(prev.filter((c) => c.id !== columnId));
    deleteProjectColumn(token, handle, repoName, projectNumber, columnId).catch(() => {
      setColumns(prev);
      toast("Couldn't delete the column", { tone: "danger" });
    });
  }

  function reorderColumns(order: string[]) {
    const prev = columns;
    const byId = new Map(prev.map((c) => [c.id, c]));
    setColumns(order.map((id) => byId.get(id)!).filter(Boolean));
    reorderProjectColumns(token, handle, repoName, projectNumber, order).catch(() => {
      setColumns(prev);
      toast("Couldn't reorder columns", { tone: "danger" });
    });
  }

  async function toggleClosed() {
    if (!project) return;
    const next = !project.closed;
    try {
      const updated = await updateProject(token, handle, repoName, projectNumber, { closed: next });
      setProject((p) => (p ? { ...p, closed: updated.closed } : p));
      onChanged?.();
      toast(next ? "Project closed" : "Project reopened", { tone: "success" });
    } catch {
      toast("Couldn't update the project", { tone: "danger" });
    }
  }

  async function doDelete() {
    try {
      await deleteProject(token, handle, repoName, projectNumber);
      onChanged?.();
      navigate(`${base}/projects`);
    } catch {
      toast("Couldn't delete the project", { tone: "danger" });
      setConfirmDelete(false);
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 py-16 justify-center text-fh-fg-muted"><Spinner size={16} /> Loading project…</div>;
  }
  if (error || !project) {
    return (
      <EmptyState
        icon={<ProjectIcon size={32} />}
        title="Project not found"
        description={error ?? "This project does not exist or you do not have access."}
        actions={<Link to={`${base}/projects`}><Button variant="default">Back to projects</Button></Link>}
      />
    );
  }

  return (
    <div>
      {/* Project header */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link to={`${base}/projects`} className="text-fh-sm text-fh-accent-fg hover:underline">Projects</Link>
            <span className="text-fh-fg-subtle">/</span>
            <h2 className="text-fh-xl font-semibold text-fh-fg truncate">{project.name}</h2>
            <span className="text-fh-fg-subtle text-fh-lg">#{project.number}</span>
            {project.closed && <Badge tone="purple">Closed</Badge>}
          </div>
          {project.description && <p className="mt-1 text-fh-base text-fh-fg-muted max-w-3xl">{project.description}</p>}
          <p className="mt-1 text-fh-sm text-fh-fg-subtle">{itemCount} {itemCount === 1 ? "item" : "items"}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* View toggle */}
          <div className="inline-flex rounded-md border border-fh-border overflow-hidden" role="tablist" aria-label="View">
            <ViewToggleButton active={view === "board"} onClick={() => setView("board")} icon={<BoardIcon size={15} />}>Board</ViewToggleButton>
            <ViewToggleButton active={view === "table"} onClick={() => setView("table")} icon={<TableIcon size={15} />}>Table</ViewToggleButton>
          </div>

          {canWrite && (
            <DropdownMenu
              align="end"
              trigger={
                <Button variant="default" size="sm" aria-label="Project actions"><KebabIcon size={16} /></Button>
              }
            >
              <DropdownItem leadingIcon={<PencilIcon size={14} />} onSelect={() => setEditing(true)}>Edit details</DropdownItem>
              <DropdownItem onSelect={toggleClosed}>{project.closed ? "Reopen project" : "Close project"}</DropdownItem>
              <DropdownSeparator />
              <DropdownItem danger leadingIcon={<TrashIcon size={14} />} onSelect={() => setConfirmDelete(true)}>Delete project</DropdownItem>
            </DropdownMenu>
          )}
        </div>
      </div>

      {view === "board" ? (
        <BoardView
          token={token}
          handle={handle}
          repoName={repoName}
          base={base}
          projectNumber={projectNumber}
          columns={columns}
          canWrite={canWrite}
          onMoveItem={moveItem}
          onAddItem={addItem}
          onRemoveItem={removeItem}
          onAddColumn={addColumn}
          onRenameColumn={renameColumn}
          onDeleteColumn={deleteColumn}
          onReorderColumns={reorderColumns}
        />
      ) : itemCount === 0 ? (
        <EmptyState
          bordered
          icon={<TableIcon size={28} />}
          title="Nothing to show here yet"
          description="Add issues or pull requests from the board's column footers to populate the table."
        />
      ) : (
        <TableView columns={columns} base={base} canWrite={canWrite} onRemoveItem={removeItem} />
      )}

      {editing && (
        <EditProjectDialog
          initialName={project.name}
          initialDescription={project.description ?? ""}
          onClose={() => setEditing(false)}
          onSave={async (name, description) => {
            const updated = await updateProject(token, handle, repoName, projectNumber, { name, description: description || null });
            setProject((p) => (p ? { ...p, name: updated.name, description: updated.description } : p));
            setEditing(false);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete project?"
        message={`"${project.name}" and all of its columns and cards will be permanently removed. The referenced issues and pull requests are not affected.`}
        confirmLabel="Delete project"
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function ViewToggleButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1.5 h-8 px-3 text-fh-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis",
        active ? "bg-fh-accent-muted text-fh-accent-fg" : "bg-fh-surface text-fh-fg-muted hover:bg-fh-surface-muted",
      )}
    >
      {icon}{children}
    </button>
  );
}

function EditProjectDialog({
  initialName, initialDescription, onSave, onClose,
}: { initialName: string; initialDescription: string; onSave: (name: string, description: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try { await onSave(name.trim(), description.trim()); }
    catch { toast("Couldn't save changes", { tone: "danger" }); setBusy(false); }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit project"
      footer={
        <>
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" required>
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Description">
          {(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
