import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Avatar, Button, DropdownMenu, DropdownItem, DropdownLabel,
  EmptyState, LabelChip, RelativeTime, Spinner, TextInput,
} from "../../../ui";
import { CheckIcon, SearchIcon } from "../../../ui/icons";
import { listIssues, listLabels, listRepoMembers, RepoMember } from "../../../api";
import type { Issue, Label } from "../../../types";
import { StateIcon } from "./parts";
import { FilterTrigger } from "./pickers";
import { CommentIcon, IssueOpenedIcon, PersonIcon, SortIcon, TagIcon } from "./icons";

type Sort = "newest" | "oldest";

export function IssuesListView({ token, handle, repoName }: {
  token: string; handle: string; repoName: string;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const [all, setAll] = useState<Issue[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [state, setState] = useState<"open" | "closed">("open");
  const [search, setSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("newest");

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      listIssues(token, handle, repoName, "all"),
      listLabels(token, handle, repoName).catch(() => ({ labels: [] })),
      listRepoMembers(token, handle, repoName).catch(() => ({ members: [] })),
    ])
      .then(([iss, lbl, mem]) => {
        setAll(iss.issues);
        setLabels(lbl.labels);
        setMembers(mem.members);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load issues"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  const hasActiveFilter = !!(search.trim() || labelFilter || authorFilter || assigneeFilter);

  // Everything but the open/closed toggle is applied first, so the counts reflect
  // the current query the way GitHub's do.
  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((i) => {
      if (q && !i.title.toLowerCase().includes(q)) return false;
      if (labelFilter && !i.labels.some((l) => l.name === labelFilter)) return false;
      if (authorFilter && i.author !== authorFilter) return false;
      if (assigneeFilter && i.assignee !== assigneeFilter) return false;
      return true;
    });
  }, [all, search, labelFilter, authorFilter, assigneeFilter]);

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

  function clearFilters() {
    setSearch(""); setLabelFilter(null); setAuthorFilter(null); setAssigneeFilter(null);
  }

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
    <div className="flex items-center gap-0.5">
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
        <Button variant="primary" onClick={() => navigate(`${base}/issues/new`)}>New issue</Button>
      </div>

      <div className="border border-fh-border rounded-md overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-fh-surface-muted border-b border-fh-border">
          {toggle}
          {filters}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 bg-fh-surface">
            <Spinner size={20} />
          </div>
        ) : error ? (
          <div className="py-12 bg-fh-surface">
            <EmptyState title="Couldn't load issues" description={error} />
          </div>
        ) : all.length === 0 ? (
          <div className="bg-fh-surface">
            <EmptyState
              icon={<IssueOpenedIcon size={28} />}
              title="No issues yet"
              description="Issues track ideas, enhancements, tasks and bugs for this repository. Open one to start the conversation."
              actions={<Button variant="primary" onClick={() => navigate(`${base}/issues/new`)}>New issue</Button>}
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-fh-surface">
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
          <ul className="divide-y divide-fh-border bg-fh-surface">
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
    </div>
  );
}
