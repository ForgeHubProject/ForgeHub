import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Avatar, Button, cx, Dialog, DropdownMenu, DropdownItem, DropdownLabel,
  EmptyState, LabelChip, RelativeTime, Spinner, TextInput,
} from "../../../ui";
import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "../../../ui/icons";
import {
  createSavedFilter, deleteSavedFilter, listIssues, listLabels, listMilestones, listRepoMembers,
  listSavedFilters, RepoMember,
} from "../../../api";
import type { Issue, Label, Milestone, SavedFilter } from "../../../types";
import { StateIcon } from "./parts";
import { FilterTrigger, Popover } from "./pickers";
import { BookmarkIcon, CommentIcon, IssueOpenedIcon, MilestoneIcon, PersonIcon, PinIcon, SortIcon, TagIcon } from "./icons";

type Sort = "newest" | "oldest";

export function IssuesListView({ token, handle, repoName }: {
  token: string; handle: string; repoName: string;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const base = `/${handle}/${repoName}`;

  const [all, setAll] = useState<Issue[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [state, setState] = useState<"open" | "closed">("open");
  const [search, setSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  // Milestone filter: a milestone number as a string, the sentinel "none"
  // (issues with no milestone), or null (any).
  const [milestoneFilter, setMilestoneFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("newest");

  // Saved views (#120): save dialog + one-time apply of a `?view=` deep link.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const appliedViewRef = useRef<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      listIssues(token, handle, repoName, "all"),
      listLabels(token, handle, repoName).catch(() => ({ labels: [] })),
      listRepoMembers(token, handle, repoName).catch(() => ({ members: [] })),
      listSavedFilters(token, handle, repoName).catch(() => ({ savedFilters: [] })),
      listMilestones(token, handle, repoName, "all").catch(() => ({ milestones: [], counts: { open: 0, closed: 0 } })),
    ])
      .then(([iss, lbl, mem, sf, ms]) => {
        setAll(iss.issues);
        setLabels(lbl.labels);
        setMembers(mem.members);
        setSavedFilters(sf.savedFilters);
        setMilestones(ms.milestones);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load issues"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  /** Serialize the current filter combo to a query string (for a saved view). */
  function currentQuery(): string {
    const p = new URLSearchParams();
    p.set("state", state);
    if (search.trim()) p.set("q", search.trim());
    if (labelFilter) p.set("label", labelFilter);
    if (authorFilter) p.set("author", authorFilter);
    if (assigneeFilter) p.set("assignee", assigneeFilter);
    if (milestoneFilter) p.set("milestone", milestoneFilter);
    if (sort !== "newest") p.set("sort", sort);
    return p.toString();
  }

  /** Apply a serialized filter combo back onto the controls. */
  function applyQuery(query: string) {
    const p = new URLSearchParams(query);
    setState(p.get("state") === "closed" ? "closed" : "open");
    setSearch(p.get("q") ?? "");
    setLabelFilter(p.get("label"));
    setAuthorFilter(p.get("author"));
    setAssigneeFilter(p.get("assignee"));
    setMilestoneFilter(p.get("milestone"));
    setSort(p.get("sort") === "oldest" ? "oldest" : "newest");
  }

  function applyView(view: SavedFilter) {
    applyQuery(view.query);
    setSearchParams({ view: view.id });
  }

  async function removeView(view: SavedFilter) {
    try {
      await deleteSavedFilter(token, handle, repoName, view.id);
      setSavedFilters((prev) => prev.filter((f) => f.id !== view.id));
      if (searchParams.get("view") === view.id) setSearchParams({});
    } catch { /* keep list on failure */ }
  }

  async function submitSaveView(e: React.FormEvent) {
    e.preventDefault();
    if (!saveName.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await createSavedFilter(token, handle, repoName, saveName.trim(), currentQuery());
      setSavedFilters((prev) => [...prev, created]);
      setSaveOpen(false);
      setSaveName("");
      setSearchParams({ view: created.id });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Couldn't save this view");
    } finally {
      setSaving(false);
    }
  }

  // Apply a `?view=<id>` deep link once its saved filter has loaded.
  useEffect(() => {
    const viewId = searchParams.get("view");
    if (!viewId || appliedViewRef.current === viewId) return;
    const match = savedFilters.find((f) => f.id === viewId);
    if (match) {
      appliedViewRef.current = viewId;
      applyQuery(match.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedFilters, searchParams]);

  const hasActiveFilter = !!(search.trim() || labelFilter || authorFilter || assigneeFilter || milestoneFilter);
  const activeView = searchParams.get("view");

  // Everything but the open/closed toggle is applied first, so the counts reflect
  // the current query the way GitHub's do.
  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((i) => {
      if (q && !i.title.toLowerCase().includes(q)) return false;
      if (labelFilter && !i.labels.some((l) => l.name === labelFilter)) return false;
      if (authorFilter && i.author !== authorFilter) return false;
      if (assigneeFilter && i.assignee !== assigneeFilter) return false;
      if (milestoneFilter) {
        if (milestoneFilter === "none") { if (i.milestone) return false; }
        else if (String(i.milestone?.number ?? "") !== milestoneFilter) return false;
      }
      return true;
    });
  }, [all, search, labelFilter, authorFilter, assigneeFilter, milestoneFilter]);

  const openCount = matched.filter((i) => i.state === "open").length;
  const closedCount = matched.filter((i) => i.state === "closed").length;

  const visible = useMemo(() => {
    const rows = matched.filter((i) => i.state === state);
    rows.sort((a, b) => {
      const da = new Date(a.createdAt).getTime();
      const db = new Date(b.createdAt).getTime();
      return sort === "newest" ? db - da : da - db;
    });
    return rows;
  }, [matched, state, sort]);

  // Pinned issues (#120): a distinct card row above the list, most-recently-pinned
  // first. Independent of the open/closed toggle and the search box.
  const pinned = useMemo(
    () =>
      all
        .filter((i) => !!i.pinnedAt)
        .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "")),
    [all],
  );

  function clearFilters() {
    setSearch(""); setLabelFilter(null); setAuthorFilter(null); setAssigneeFilter(null); setMilestoneFilter(null);
  }

  const activeMilestone = milestoneFilter
    ? (milestoneFilter === "none" ? "No milestone" : milestones.find((m) => String(m.number) === milestoneFilter)?.title)
    : undefined;

  const toggle = (
    <div className="flex items-center gap-4">
      {([
        ["open", openCount, "Open", <StateIcon key="o" state="open" size={16} />],
        ["closed", closedCount, "Closed", <StateIcon key="c" state="closed" size={16} />],
      ] as const).map(([s, count, text, icon]) => (
        <button
          key={s}
          type="button"
          onClick={() => setState(s)}
          className={
            "inline-flex items-center gap-1.5 text-fh-sm transition-colors " +
            (state === s ? "font-semibold text-fh-fg" : "text-fh-fg-muted hover:text-fh-fg")
          }
          aria-pressed={state === s}
        >
          {icon}
          <span>{count}</span>
          <span>{text}</span>
        </button>
      ))}
    </div>
  );

  const filters = (
    <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1">
      <DropdownMenu
        align="end"
        trigger={<FilterTrigger label="Author" active={!!authorFilter} icon={<PersonIcon size={14} />} />}
      >
        <DropdownLabel>Filter by author</DropdownLabel>
        <DropdownItem onSelect={() => setAuthorFilter(null)} trailing={!authorFilter ? <CheckIcon size={14} /> : undefined}>
          All authors
        </DropdownItem>
        {members.map((m) => (
          <DropdownItem
            key={m.id}
            onSelect={() => setAuthorFilter(m.handle)}
            leadingIcon={<Avatar name={m.displayName ?? m.handle} size={18} />}
            trailing={authorFilter === m.handle ? <CheckIcon size={14} /> : undefined}
          >
            {m.handle}
          </DropdownItem>
        ))}
      </DropdownMenu>

      <DropdownMenu
        align="end"
        trigger={<FilterTrigger label="Label" active={!!labelFilter} icon={<TagIcon size={14} />} />}
      >
        <DropdownLabel>Filter by label</DropdownLabel>
        <DropdownItem onSelect={() => setLabelFilter(null)} trailing={!labelFilter ? <CheckIcon size={14} /> : undefined}>
          All labels
        </DropdownItem>
        {labels.length === 0 && (
          <div className="px-3 py-1.5 text-fh-sm text-fh-fg-muted">No labels yet</div>
        )}
        {labels.map((l) => (
          <DropdownItem
            key={l.id}
            onSelect={() => setLabelFilter(l.name)}
            leadingIcon={<span className="inline-block w-3 h-3 rounded-full border border-black/10" style={{ backgroundColor: `#${l.color}` }} />}
            trailing={labelFilter === l.name ? <CheckIcon size={14} /> : undefined}
          >
            {l.name}
          </DropdownItem>
        ))}
      </DropdownMenu>

      <DropdownMenu
        align="end"
        trigger={<FilterTrigger label="Assignee" active={!!assigneeFilter} icon={<PersonIcon size={14} />} />}
      >
        <DropdownLabel>Filter by assignee</DropdownLabel>
        <DropdownItem onSelect={() => setAssigneeFilter(null)} trailing={!assigneeFilter ? <CheckIcon size={14} /> : undefined}>
          Assigned to anyone
        </DropdownItem>
        {members.map((m) => (
          <DropdownItem
            key={m.id}
            onSelect={() => setAssigneeFilter(m.handle)}
            leadingIcon={<Avatar name={m.displayName ?? m.handle} size={18} />}
            trailing={assigneeFilter === m.handle ? <CheckIcon size={14} /> : undefined}
          >
            {m.handle}
          </DropdownItem>
        ))}
      </DropdownMenu>

      <DropdownMenu
        align="end"
        trigger={<FilterTrigger label={activeMilestone ?? "Milestone"} active={!!milestoneFilter} icon={<MilestoneIcon size={14} />} />}
      >
        <DropdownLabel>Filter by milestone</DropdownLabel>
        <DropdownItem onSelect={() => setMilestoneFilter(null)} trailing={!milestoneFilter ? <CheckIcon size={14} /> : undefined}>
          All milestones
        </DropdownItem>
        <DropdownItem onSelect={() => setMilestoneFilter("none")} trailing={milestoneFilter === "none" ? <CheckIcon size={14} /> : undefined}>
          No milestone
        </DropdownItem>
        {milestones.length === 0 && (
          <div className="px-3 py-1.5 text-fh-sm text-fh-fg-muted">No milestones yet</div>
        )}
        {milestones.map((m) => (
          <DropdownItem
            key={m.id}
            onSelect={() => setMilestoneFilter(String(m.number))}
            leadingIcon={<MilestoneIcon size={14} />}
            trailing={milestoneFilter === String(m.number) ? <CheckIcon size={14} /> : undefined}
          >
            {m.title}
          </DropdownItem>
        ))}
      </DropdownMenu>

      <DropdownMenu
        align="end"
        trigger={<FilterTrigger label="Sort" active={sort !== "newest"} icon={<SortIcon size={14} />} />}
      >
        <DropdownLabel>Sort by</DropdownLabel>
        <DropdownItem onSelect={() => setSort("newest")} trailing={sort === "newest" ? <CheckIcon size={14} /> : undefined}>
          Newest
        </DropdownItem>
        <DropdownItem onSelect={() => setSort("oldest")} trailing={sort === "oldest" ? <CheckIcon size={14} /> : undefined}>
          Oldest
        </DropdownItem>
      </DropdownMenu>

      {/* Saved views (#120): apply / delete own views, or save the current combo. */}
      <Popover
        align="end"
        width={264}
        trigger={(_open, toggle) => (
          <button
            type="button"
            onClick={toggle}
            className={cx(
              "inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-fh-sm font-medium transition-colors hover:bg-fh-surface-muted",
              activeView ? "text-fh-fg" : "text-fh-fg-muted hover:text-fh-fg",
            )}
          >
            <span className="inline-flex shrink-0 text-fh-fg-subtle"><BookmarkIcon size={14} /></span>
            Views
            <ChevronDownIcon size={12} className="text-fh-fg-subtle" />
          </button>
        )}
      >
        <DropdownLabel>Saved views</DropdownLabel>
        {savedFilters.length === 0 && (
          <div className="px-3 py-1.5 text-fh-sm text-fh-fg-muted">No saved views yet</div>
        )}
        {savedFilters.map((f) => (
          <div key={f.id} className="flex items-center gap-1 px-1.5">
            <button
              type="button"
              onClick={() => applyView(f)}
              className={cx(
                "flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1.5 rounded text-left hover:bg-fh-surface-muted transition-colors",
                activeView === f.id ? "text-fh-accent-fg font-medium" : "text-fh-fg",
              )}
            >
              <BookmarkIcon size={14} className="shrink-0 text-fh-fg-subtle" />
              <span className="truncate text-fh-sm">{f.name}</span>
              {activeView === f.id && <CheckIcon size={14} className="ml-auto shrink-0" />}
            </button>
            <button
              type="button"
              onClick={() => removeView(f)}
              aria-label={`Delete view ${f.name}`}
              className="shrink-0 p-1 rounded text-fh-fg-subtle hover:text-fh-danger-fg hover:bg-fh-danger-muted transition-colors"
            >
              <XIcon size={14} />
            </button>
          </div>
        ))}
        <div className="my-1 h-px bg-fh-border-muted" />
        <button
          type="button"
          onClick={() => { setSaveError(null); setSaveName(""); setSaveOpen(true); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-fh-sm text-fh-fg hover:bg-fh-surface-muted transition-colors"
        >
          <BookmarkIcon size={14} className="text-fh-fg-subtle" />
          Save current view…
        </button>
      </Popover>
    </div>
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-0">
          <SearchIcon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fh-fg-muted pointer-events-none" />
          <TextInput
            className="pl-8"
            placeholder="Search issues by title"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search issues"
          />
        </div>
        <Button
          variant="default"
          leadingIcon={<MilestoneIcon size={16} />}
          onClick={() => navigate(`${base}/issues/milestones`)}
        >
          Milestones
        </Button>
        <Button variant="primary" onClick={() => navigate(`${base}/issues/new`)}>New issue</Button>
      </div>

      {/* Pinned issues card row (#120) — GitHub anatomy: a distinct band above the
          list, capped at the server's pin limit. */}
      {!loading && pinned.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-1.5 mb-2 text-fh-sm font-semibold text-fh-fg">
            <PinIcon size={14} className="text-fh-accent-fg" />
            Pinned {pinned.length === 1 ? "issue" : "issues"}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pinned.map((issue) => (
              <Link
                key={issue.id}
                to={`${base}/issues/${issue.number}`}
                className="group flex flex-col border border-fh-border rounded-md bg-fh-surface p-3 hover:border-fh-border-strong transition-colors"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0"><StateIcon state={issue.state} size={14} /></span>
                  <span className="flex-1 min-w-0 text-fh-sm font-semibold text-fh-fg group-hover:text-fh-accent-fg line-clamp-2">
                    {issue.title}
                  </span>
                  <span className="shrink-0 text-fh-accent-fg" aria-label="Pinned"><PinIcon size={14} /></span>
                </div>
                <div className="mt-1.5 text-fh-xs text-fh-fg-muted">#{issue.number}</div>
                {issue.labels.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {issue.labels.map((l) => (
                      <LabelChip key={l.id} name={l.name} color={l.color} />
                    ))}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* No overflow-clip on the outer container: the filter menus need to
          escape it (short lists would otherwise clip the open panel). */}
      <div className="border border-fh-border rounded-md">
        <div className="flex flex-col gap-2 px-4 py-2.5 bg-fh-surface-muted border-b border-fh-border rounded-t-md sm:flex-row sm:items-center sm:justify-between">
          {toggle}
          {filters}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 bg-fh-surface rounded-b-md">
            <Spinner size={20} />
          </div>
        ) : error ? (
          <div className="py-12 bg-fh-surface rounded-b-md">
            <EmptyState title="Couldn't load issues" description={error} />
          </div>
        ) : all.length === 0 ? (
          <div className="bg-fh-surface rounded-b-md">
            <EmptyState
              icon={<IssueOpenedIcon size={28} />}
              title="No issues yet"
              description="Issues track ideas, enhancements, tasks and bugs for this repository. Open one to start the conversation."
              actions={<Button variant="primary" onClick={() => navigate(`${base}/issues/new`)}>New issue</Button>}
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-fh-surface rounded-b-md">
            <EmptyState
              icon={<IssueOpenedIcon size={28} />}
              title={hasActiveFilter ? "No issues match your filters" : state === "open" ? "No open issues" : "No closed issues"}
              description={
                hasActiveFilter
                  ? "Try removing a filter or searching for something else."
                  : state === "open"
                    ? "Every issue here has been closed. Nice work."
                    : "Nothing has been closed yet."
              }
              actions={
                hasActiveFilter
                  ? <Button variant="default" onClick={clearFilters}>Clear filters</Button>
                  : state === "open"
                    ? <Button variant="primary" onClick={() => navigate(`${base}/issues/new`)}>New issue</Button>
                    : undefined
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-fh-border bg-fh-surface rounded-b-md overflow-hidden">
            {visible.map((issue) => (
              <li key={issue.id}>
                <Link
                  to={`${base}/issues/${issue.number}`}
                  className="group flex items-start gap-3 px-4 py-3 hover:bg-fh-surface-muted transition-colors"
                >
                  <span className="mt-0.5 shrink-0">
                    <StateIcon state={issue.state} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-x-2 gap-y-1 flex-wrap">
                      <span className="text-fh-base font-semibold text-fh-fg group-hover:text-fh-accent-fg">
                        {issue.title}
                      </span>
                      {issue.labels.map((l) => (
                        <LabelChip key={l.id} name={l.name} color={l.color} />
                      ))}
                    </div>
                    <div className="mt-1 text-fh-sm text-fh-fg-muted">
                      #{issue.number}{" "}
                      {issue.state === "open" ? "opened " : "closed "}
                      <RelativeTime date={issue.state === "open" ? issue.createdAt : (issue.closedAt ?? issue.updatedAt)} />
                      {" by "}{issue.author}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 pl-2">
                    {issue.assignee && (
                      <Avatar name={issue.assignee} size={20} title={`Assigned to ${issue.assignee}`} />
                    )}
                    {issue.commentCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-fh-sm text-fh-fg-muted group-hover:text-fh-fg">
                        <CommentIcon size={14} />
                        {issue.commentCount}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Save-current-view dialog (#120) */}
      <Dialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save this view"
        description="Name the current filter combo to reuse it later or share it via a link."
        size="sm"
        footer={
          <>
            <Button variant="default" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={!saveName.trim()} onClick={submitSaveView}>
              Save view
            </Button>
          </>
        }
      >
        <form onSubmit={submitSaveView}>
          <label htmlFor="save-view-name" className="block text-fh-sm font-medium text-fh-fg mb-1">
            View name
          </label>
          <TextInput
            id="save-view-name"
            placeholder="e.g. My open bugs"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            autoFocus
          />
          <p className="mt-1.5 text-fh-xs text-fh-fg-subtle break-words">
            Captures: <span className="font-mono">{currentQuery() || "state=open"}</span>
          </p>
          {saveError && <p className="mt-2 text-fh-sm text-fh-danger-fg">{saveError}</p>}
        </form>
      </Dialog>
    </div>
  );
}
