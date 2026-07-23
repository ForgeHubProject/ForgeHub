import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createProject, listProjects } from "../../../api";
import {
  Button, Dialog, EmptyState, Field, Spinner, TextInput, Textarea, cx, useToast,
} from "../../../ui";
import type { ProjectSummary } from "../../../types";
import { PlusIcon, ProjectIcon } from "./parts";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  base: string;
  canWrite: boolean;
  onChanged?: () => void;
};

type StateFilter = "open" | "closed";

export function ProjectsListView({ token, handle, repoName, base, canWrite, onChanged }: Props) {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [filter, setFilter] = useState<StateFilter>("open");
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [closedCount, setClosedCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    listProjects(token, handle, repoName, filter)
      .then((d) => setProjects(d.projects))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load projects"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [token, handle, repoName, filter]);

  // Keep the open/closed segment counters fresh independently of the active filter.
  useEffect(() => {
    listProjects(token, handle, repoName, "open").then((d) => setOpenCount(d.projects.length)).catch(() => {});
    listProjects(token, handle, repoName, "closed").then((d) => setClosedCount(d.projects.length)).catch(() => {});
  }, [token, handle, repoName, projects.length]);

  return (
    <div>
      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div className="inline-flex items-center gap-4">
          <SegBtn active={filter === "open"} onClick={() => setFilter("open")}>
            <ProjectIcon size={15} /> Open{openCount != null ? ` ${openCount}` : ""}
          </SegBtn>
          <SegBtn active={filter === "closed"} onClick={() => setFilter("closed")}>
            Closed{closedCount != null ? ` ${closedCount}` : ""}
          </SegBtn>
        </div>
        {canWrite && (
          <Button variant="primary" size="sm" leadingIcon={<PlusIcon size={14} />} onClick={() => setCreating(true)}>
            New project
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-16 justify-center text-fh-fg-muted"><Spinner size={16} /> Loading projects…</div>
      ) : error ? (
        <EmptyState icon={<ProjectIcon size={32} />} title="Couldn't load projects" description={error} />
      ) : projects.length === 0 ? (
        <EmptyState
          bordered
          icon={<ProjectIcon size={32} />}
          title={filter === "open" ? "No open projects" : "No closed projects"}
          description={
            filter === "open"
              ? "Projects organize issues and pull requests into a board and a table you can sort."
              : "Closed projects are archived here."
          }
          actions={
            canWrite && filter === "open" ? (
              <Button variant="primary" leadingIcon={<PlusIcon size={14} />} onClick={() => setCreating(true)}>New project</Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="rounded-md border border-fh-border divide-y divide-fh-border-muted overflow-hidden">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to={`${base}/projects/${p.number}`}
                className="flex items-start gap-3 px-4 py-3 hover:bg-fh-surface-muted/60 transition-colors"
              >
                <span className="mt-0.5 text-fh-fg-muted"><ProjectIcon size={16} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-fh-fg hover:text-fh-accent-fg truncate">{p.name}</span>
                    <span className="text-fh-sm text-fh-fg-subtle">#{p.number}</span>
                  </div>
                  {p.description && <p className="mt-0.5 text-fh-sm text-fh-fg-muted line-clamp-2 max-w-2xl">{p.description}</p>}
                </div>
                <span className="shrink-0 text-fh-sm text-fh-fg-muted whitespace-nowrap">
                  {p.itemCount} {p.itemCount === 1 ? "item" : "items"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <Dialog
          open
          onClose={() => setCreating(false)}
          title="New project"
          description="A board and table over this repository's issues and pull requests."
        >
          <CreateProjectForm
            onCancel={() => setCreating(false)}
            onCreate={async (name, description) => {
              const project = await createProject(token, handle, repoName, name, description || undefined);
              setCreating(false);
              onChanged?.();
              toast("Project created", { tone: "success" });
              navigate(`${base}/projects/${project.number}`);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1.5 text-fh-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis rounded",
        active ? "text-fh-fg" : "text-fh-fg-muted hover:text-fh-fg",
      )}
    >
      {children}
    </button>
  );
}

function CreateProjectForm({ onCreate, onCancel }: { onCreate: (name: string, description: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try { await onCreate(name.trim(), description.trim()); }
    catch (e) { toast(e instanceof Error ? e.message : "Couldn't create the project", { tone: "danger" }); setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Name" required>
        {(id) => (
          <TextInput
            id={id}
            autoFocus
            value={name}
            placeholder="e.g. Q3 roadmap"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
          />
        )}
      </Field>
      <Field label="Description">
        {(id) => <Textarea id={id} rows={3} value={description} placeholder="What is this project for?" onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="default" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={submit}>Create project</Button>
      </div>
    </div>
  );
}
