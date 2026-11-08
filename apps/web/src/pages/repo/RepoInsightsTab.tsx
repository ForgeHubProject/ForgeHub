import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { avatarSrc, getRepoInsights } from "../../api";
import { ColumnChart, DataTable, DivergingColumnChart, type Column } from "../../components/charts";
import type { RepoInsights } from "../../types";
import { Avatar, EmptyState, PageHeading, Skeleton, cx } from "../../ui";

type Section = "contributors" | "commits" | "code-frequency";

const SECTIONS: Array<{ key: Section; label: string; path: string }> = [
  { key: "contributors", label: "Contributors", path: "insights" },
  { key: "commits", label: "Commits", path: "insights/commits" },
  { key: "code-frequency", label: "Code frequency", path: "insights/code-frequency" },
];

export function insightsSection(splat: string): Section {
  if (splat.startsWith("insights/commits")) return "commits";
  if (splat.startsWith("insights/code-frequency")) return "code-frequency";
  return "contributors";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtWeek = (week: string) => new Date(`${week}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** A tick at the first week of each month (every other or quarter when crowded). */
function monthTicks(weeks: string[]) {
  const every = weeks.length > 104 ? 3 : weeks.length > 52 ? 2 : 1;
  let months = 0;
  return (c: Column, i: number) => {
    const d = new Date(`${c.key}T00:00:00Z`);
    const prev = i > 0 ? new Date(`${weeks[i - 1]}T00:00:00Z`) : null;
    if (prev && prev.getUTCMonth() === d.getUTCMonth()) return null;
    return months++ % every === 0 ? d.toLocaleDateString(undefined, { month: "short", ...(d.getUTCMonth() === 0 ? { year: "2-digit" } : {}), timeZone: "UTC" }) : null;
  };
}

/**
 * Insights (#256), GitHub's: Contributors (commits over time, and each
 * person's share), Commits (the last year, by week and by day) and Code
 * frequency (lines added and removed each week), from the default branch,
 * merge commits left out.
 */
export function RepoInsightsTab({ token, handle, repoName, base, splat }: { token: string; handle: string; repoName: string; base: string; splat: string }) {
  const section = insightsSection(splat);
  const [data, setData] = useState<RepoInsights | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null);
    getRepoInsights(token, handle, repoName).then(setData).catch(() => setError(true));
  }, [token, handle, repoName]);

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav aria-label="Insights" className="w-full shrink-0 md:w-52">
        <ul className="flex gap-0.5 overflow-x-auto md:flex-col">
          {SECTIONS.map((s) => (
            <li key={s.key}>
              <Link
                to={`${base}/${s.path}`}
                aria-current={section === s.key ? "page" : undefined}
                className={cx(
                  "block whitespace-nowrap rounded-md px-3 py-1.5 text-fh-base no-underline",
                  section === s.key ? "bg-fh-surface-muted font-semibold text-fh-fg" : "text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg",
                )}
              >
                {s.label}
              </Link>
            </li>
          ))}
          <li>
            <Link to={`${base}/activity`} className="block whitespace-nowrap rounded-md px-3 py-1.5 text-fh-base text-fh-fg-muted no-underline hover:bg-fh-surface-muted hover:text-fh-fg">
              Activity
            </Link>
          </li>
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        {error ? (
          <EmptyState bordered title="Couldn't load insights" />
        ) : !data ? (
          <Skeleton width="100%" height={240} />
        ) : !data.sha ? (
          <EmptyState bordered title="Nothing to chart yet" description="Insights appear once the repository has commits." />
        ) : section === "contributors" ? (
          <Contributors data={data} />
        ) : section === "commits" ? (
          <Commits data={data} />
        ) : (
          <CodeFrequency data={data} />
        )}
        {data?.truncated && (
          <p className="mt-4 text-fh-xs text-fh-fg-muted">Counted the latest {data.scanned.toLocaleString()} commits; older history isn't included.</p>
        )}
      </div>
    </div>
  );
}

function Contributors({ data }: { data: RepoInsights }) {
  const weeks = data.weeks.map((w) => w.week);
  const ticks = useMemo(() => monthTicks(weeks), [weeks]);
  const columns: Column[] = data.weeks.map((w) => ({ key: w.week, label: `Week of ${fmtWeek(w.week)}`, value: w.commits }));
  const shared = Math.max(1, ...data.authors.flatMap((a) => Object.values(a.weeks)));
  return (
    <div>
      <PageHeading title="Contributors" description={`Commits to ${data.ref}, excluding merge commits.`} divider />
      <section aria-label="Commits over time" className="rounded-md border border-fh-border bg-fh-surface p-4">
        <h2 className="mb-3 text-fh-sm font-semibold text-fh-fg">Commits per week</h2>
        <ColumnChart columns={columns} unit="commits" ariaLabel="Commits per week" tickLabel={ticks} />
        <DataTable caption="Commits per week" headers={["Week of", "Commits"]} rows={data.weeks.map((w) => [w.week, w.commits])} />
      </section>
      <ol className="mt-6 grid gap-4 lg:grid-cols-2">
        {data.authors.map((a, rank) => (
          <li key={`${a.name}-${rank}`} className="rounded-md border border-fh-border bg-fh-surface p-4">
            <div className="mb-3 flex items-center gap-3">
              <Avatar name={a.user?.displayName || a.name} src={a.user ? avatarSrc(a.user.handle, a.user.avatarKey) : undefined} size={32} />
              <div className="min-w-0 flex-1">
                {a.user ? (
                  <Link to={`/${a.user.handle}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">{a.user.handle}</Link>
                ) : (
                  <span className="font-semibold text-fh-fg">{a.name}</span>
                )}
                <p className="text-fh-xs text-fh-fg-muted">
                  {a.commits.toLocaleString()} {a.commits === 1 ? "commit" : "commits"}
                  {" · "}
                  <span>+{a.additions.toLocaleString()}</span>
                  {" · "}
                  <span>−{a.deletions.toLocaleString()}</span>
                </p>
              </div>
              <span className="text-fh-xs text-fh-fg-muted">#{rank + 1}</span>
            </div>
            <ColumnChart
              columns={data.weeks.map((w) => ({ key: w.week, label: `Week of ${fmtWeek(w.week)}`, value: a.weeks[w.week] ?? 0 }))}
              unit="commits"
              ariaLabel={`${a.user?.handle ?? a.name}'s commits per week`}
              maxValue={shared}
              height={64}
              compactAxis
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Commits({ data }: { data: RepoInsights }) {
  const year = data.weeks.slice(-52);
  // `days` holds the last 52 weeks; line them up with however many weeks there are.
  const days = data.days.slice(-year.length);
  const columns: Column[] = year.map((w, i) => ({ key: w.week, label: `Week of ${fmtWeek(w.week)}`, value: days[i]?.reduce((n, d) => n + d, 0) ?? w.commits }));
  // Start on the latest week that had commits, as GitHub does.
  const latest = columns.reduce((last, c, i) => (c.value > 0 ? i : last), columns.length - 1);
  const [selected, setSelected] = useState(latest);
  const ticks = useMemo(() => monthTicks(year.map((w) => w.week)), [year]);
  const week = year[selected];
  const dayColumns: Column[] = DAYS.map((d, i) => ({ key: d, label: d, value: days[selected]?.[i] ?? 0 }));
  return (
    <div>
      <PageHeading title="Commits" description={`Commits to ${data.ref} over the last year, excluding merge commits. Pick a week to see its days.`} divider />
      <section aria-label="Commits per week" className="rounded-md border border-fh-border bg-fh-surface p-4">
        <ColumnChart columns={columns} unit="commits" ariaLabel="Commits per week over the last year" tickLabel={ticks} selected={selected} onSelect={setSelected} />
        <DataTable caption="Commits per week" headers={["Week of", ...DAYS, "Total"]} rows={year.map((w, i) => [w.week, ...(days[i] ?? [0, 0, 0, 0, 0, 0, 0]), columns[i].value])} />
      </section>
      {week && (
        <section aria-label="Commits by day" className="mt-4 rounded-md border border-fh-border bg-fh-surface p-4">
          <h2 className="mb-3 text-fh-sm font-semibold text-fh-fg">Week of {fmtWeek(week.week)}</h2>
          <ColumnChart columns={dayColumns} unit="commits" ariaLabel={`Commits by day, week of ${week.week}`} height={140} tickLabel={(c) => c.label} />
        </section>
      )}
    </div>
  );
}

function CodeFrequency({ data }: { data: RepoInsights }) {
  const ticks = useMemo(() => monthTicks(data.weeks.map((w) => w.week)), [data.weeks]);
  const added = data.weeks.reduce((n, w) => n + w.additions, 0);
  const removed = data.weeks.reduce((n, w) => n + w.deletions, 0);
  return (
    <div>
      <PageHeading title="Code frequency" description={`Lines added and removed on ${data.ref} each week, excluding merge commits.`} divider />
      <section aria-label="Code frequency" className="rounded-md border border-fh-border bg-fh-surface p-4">
        <p className="mb-3 text-fh-sm text-fh-fg-muted">
          <span className="font-semibold text-fh-fg">+{added.toLocaleString()}</span> added,{" "}
          <span className="font-semibold text-fh-fg">−{removed.toLocaleString()}</span> removed
        </p>
        <DivergingColumnChart
          columns={data.weeks.map((w) => ({ key: w.week, label: `Week of ${fmtWeek(w.week)}`, up: w.additions, down: w.deletions }))}
          up={{ name: "Additions", className: "fill-fh-success-emphasis" }}
          down={{ name: "Deletions", className: "fill-fh-danger-emphasis" }}
          ariaLabel="Lines added and removed per week"
          tickLabel={ticks}
        />
        <DataTable caption="Lines added and removed per week" headers={["Week of", "Additions", "Deletions"]} rows={data.weeks.map((w) => [w.week, w.additions, w.deletions])} />
      </section>
    </div>
  );
}
