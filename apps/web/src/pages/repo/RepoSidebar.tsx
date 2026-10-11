/**
 * The Code tab's sidebar at a repository's root (issues #208, #209): About,
 * then the sections that follow it — Formats (CompositionBar), Releases and
 * Contributors. GitHub's anatomy: what the repository is, what it is made of,
 * what has shipped, and who made it.
 *
 * Every section that fetches is best-effort and stays out of the way when its
 * request fails or comes back empty, like the formats bar always has.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { avatarSrc, getContributors, listReleases } from "../../api";
import type { Contributor, Release, Repo, RepoSocial } from "../../types";
import { Avatar, Badge, RelativeTime, Skeleton, Tooltip, cx } from "../../ui";
import { TopicChips } from "../listShared";
import { SidebarSection } from "./SidebarSection";

// ── local icons (Octicon-style, currentColor) ────────────────────────────────
function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={cx("shrink-0", className ?? "text-fh-fg-muted")}>
      <path fillRule="evenodd" d={d} />
    </svg>
  );
}
const BOOK = "M0 1.75A.75.75 0 01.75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0111.006 1h4.245a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75h-4.507a2.25 2.25 0 00-1.591.659l-.622.621a.75.75 0 01-1.062 0l-.622-.621A2.25 2.25 0 005.258 13H.75a.75.75 0 01-.75-.75V1.75zm7.75 3.19v8.502A3.75 3.75 0 0111.006 11.5h3.744V2.5h-3.5a2.25 2.25 0 00-2.25 2.25v.19zm-1.5 8.502V4.75A2.25 2.25 0 004.75 2.5H1.25v9h4.008a3.75 3.75 0 01.992.132V13.442z";
const LAW = "M8.75.75V2h.985c.304 0 .603.08.867.231l1.29.736c.038.022.08.033.124.033h2.234a.75.75 0 010 1.5h-.427l2.111 4.692a.75.75 0 01-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.006.005-.01.01-.045.04c-.21.176-.441.327-.686.45C14.556 10.78 13.88 11 13 11a4.498 4.498 0 01-2.023-.454 3.544 3.544 0 01-.686-.45l-.045-.04-.016-.015-.006-.006-.004-.004v-.001a.75.75 0 01-.154-.838L12.178 4.5h-.162c-.305 0-.604-.079-.868-.231l-1.29-.736a.245.245 0 00-.124-.033H8.75V13h2.5a.75.75 0 010 1.5h-6.5a.75.75 0 010-1.5h2.5V3.5h-.984a.245.245 0 00-.124.033l-1.289.737c-.265.15-.564.23-.869.23h-.162l2.112 4.692a.75.75 0 01-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.016.015-.045.04c-.21.176-.441.327-.686.45C4.556 10.78 3.88 11 3 11a4.498 4.498 0 01-2.023-.454 3.544 3.544 0 01-.686-.45l-.045-.04-.016-.015-.006-.006-.004-.004v-.001a.75.75 0 01-.154-.838L2.178 4.5H1.75a.75.75 0 010-1.5h2.234a.249.249 0 00.125-.033l1.288-.737c.265-.15.564-.23.869-.23h.984V.75a.75.75 0 011.5 0zm2.945 8.477c.285.135.718.273 1.305.273s1.02-.138 1.305-.273L13 6.327zm-10 0c.285.135.718.273 1.305.273s1.02-.138 1.305-.273L3 6.327z";
const STAR = "M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694v.001z";
const EYE = "M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 010 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 010-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2zM1.679 7.932a.12.12 0 000 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 000-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717zM8 10a2 2 0 110-4 2 2 0 010 4z";
const FORK = "M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z";
const TAG = "M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z";
const GEAR = "M8 0a8.2 8.2 0 01.701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 01-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 01-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 01-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 01-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 01-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 010-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 01.704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 000 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 001.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 000-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 00-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 00-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 00-1.142 0zM11 8a3 3 0 11-6 0 3 3 0 016 0zM9.5 8a1.5 1.5 0 10-3.001.001A1.5 1.5 0 009.5 8z";

const ROW = "flex items-center gap-2 text-fh-sm text-fh-fg-muted";
const ROW_LINK = `${ROW} no-underline hover:text-fh-accent-fg`;

/** How many contributor avatars the sidebar shows before "+ N more". */
const MAX_AVATARS = 14;

// ── About ─────────────────────────────────────────────────────────────────────

export function AboutSection({
  repo,
  social,
  base,
  defaultBranch,
  hasReadme,
  canEditSettings,
}: {
  repo: Repo;
  social: RepoSocial | null;
  base: string;
  defaultBranch: string;
  hasReadme: boolean;
  canEditSettings: boolean;
}) {
  const topics = repo.topics ?? [];
  const stars = social?.starCount ?? repo.starCount ?? 0;
  const forks = repo.forkCount ?? 0;
  return (
    <SidebarSection
      title="About"
      action={
        canEditSettings && (
          <Tooltip label="Edit repository details">
            <Link to={`${base}/settings`} aria-label="Edit repository details" className="inline-flex text-fh-fg-muted hover:text-fh-accent-fg">
              <Glyph d={GEAR} />
            </Link>
          </Tooltip>
        )
      }
    >
      {repo.description ? (
        <p className="text-fh-base text-fh-fg break-words">{repo.description}</p>
      ) : (
        <p className="text-fh-sm italic text-fh-fg-subtle">No description or topics provided.</p>
      )}
      {topics.length > 0 && <TopicChips topics={topics} className="mt-3" />}

      <ul className="mt-4 space-y-2 list-none m-0 p-0">
        {hasReadme && (
          <li>
            <a href="#readme" className={ROW_LINK}>
              <Glyph d={BOOK} /> Readme
            </a>
          </li>
        )}
        {repo.license && (
          <li>
            <Link
              to={`${base}/blob/${defaultBranch}/${repo.license.path}`}
              title={`Licensed under ${repo.license.spdxId} — view ${repo.license.path}`}
              className={ROW_LINK}
            >
              <Glyph d={LAW} /> {repo.license.spdxId} license
            </Link>
          </li>
        )}
        <li className={ROW}>
          <Glyph d={STAR} />
          <span><strong className="font-semibold text-fh-fg">{stars}</strong> {stars === 1 ? "star" : "stars"}</span>
        </li>
        {social && (
          <li className={ROW}>
            <Glyph d={EYE} />
            <span><strong className="font-semibold text-fh-fg">{social.watcherCount}</strong> watching</span>
          </li>
        )}
        <li>
          <Link to={`${base}/forks`} className={ROW_LINK}>
            <Glyph d={FORK} />
            <span><strong className="font-semibold text-fh-fg">{forks}</strong> {forks === 1 ? "fork" : "forks"}</span>
          </Link>
        </li>
      </ul>
    </SidebarSection>
  );
}

// ── Releases ──────────────────────────────────────────────────────────────────

/**
 * What the Releases section shows, by GitHub's rules: a draft is not a release
 * yet (the API lists drafts to writers), and a prerelease is never "Latest" —
 * the newest published full release is. `releases` arrive newest first.
 */
export function summarizeReleases(releases: Release[]): { published: Release[]; latest: Release | null } {
  const published = releases.filter((r) => !r.isDraft);
  return { published, latest: published.find((r) => !r.isPrerelease) ?? null };
}

/** Published releases and the latest one (summarizeReleases). */
export function ReleasesSection({ token, handle, repoName, base }: { token: string | null; handle: string; repoName: string; base: string }) {
  const [releases, setReleases] = useState<Release[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listReleases(token, handle, repoName)
      .then((d) => { if (!cancelled) setReleases(summarizeReleases(d.releases).published); })
      .catch(() => { if (!cancelled) setReleases([]); });
    return () => { cancelled = true; };
  }, [token, handle, repoName]);

  if (releases === null) {
    return (
      <SidebarSection title="Releases">
        <Skeleton className="h-3.5 w-2/3" />
      </SidebarSection>
    );
  }
  const { latest } = summarizeReleases(releases);
  return (
    <SidebarSection title="Releases" count={releases.length > 0 ? releases.length : undefined}>
      {latest ? (
        <Link to={`${base}/releases`} className="group flex items-start gap-2 no-underline">
          <span className="mt-0.5"><Glyph d={TAG} className="text-fh-success-fg" /></span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-fh-fg group-hover:text-fh-accent-fg break-words">{latest.name || latest.tagName}</span>
              <Badge variant="outline" tone="success">Latest</Badge>
            </span>
            <RelativeTime date={latest.createdAt} className="block text-fh-xs text-fh-fg-muted" />
          </span>
        </Link>
      ) : (
        releases.length === 0 && <p className="text-fh-sm text-fh-fg-subtle">No releases published</p>
      )}
      {releases.length > (latest ? 1 : 0) && (
        <Link to={`${base}/releases`} className="mt-2 inline-block text-fh-sm text-fh-accent-fg no-underline hover:underline">
          {latest ? `+ ${releases.length - 1} ${releases.length - 1 === 1 ? "release" : "releases"}` : `${releases.length} prereleases`}
        </Link>
      )}
    </SidebarSection>
  );
}

// ── Contributors ──────────────────────────────────────────────────────────────

function ContributorAvatar({ c }: { c: Contributor }) {
  const label = `${c.user?.displayName || c.user?.handle || c.name} · ${c.commits} ${c.commits === 1 ? "commit" : "commits"}`;
  if (c.user) {
    return (
      <Tooltip label={label}>
        <Link to={`/${c.user.handle}`} aria-label={label} className="inline-flex rounded-full">
          <Avatar name={c.user.displayName || c.user.handle} src={avatarSrc(c.user.handle, c.user.avatarKey)} size={32} />
        </Link>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={label}>
      <span aria-label={label} role="img" className="inline-flex rounded-full">
        <Avatar name={c.name} size={32} />
      </span>
    </Tooltip>
  );
}

/** Commit authors at the ref being viewed (issue #209). */
export function ContributorsSection({ token, handle, repoName, refName }: { token: string | null; handle: string; repoName: string; refName: string }) {
  const [data, setData] = useState<{ total: number; contributors: Contributor[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!refName) return;
    let cancelled = false;
    setFailed(false);
    getContributors(token, handle, repoName, refName)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [token, handle, repoName, refName]);

  if (failed || (data && data.total === 0)) return null;
  if (!data) {
    return (
      <SidebarSection title="Contributors">
        <div className="flex gap-1.5">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="circle" className="h-8 w-8" />)}
        </div>
      </SidebarSection>
    );
  }
  const shown = data.contributors.slice(0, MAX_AVATARS);
  return (
    <SidebarSection title="Contributors" count={data.total}>
      <ul className="flex flex-wrap gap-1.5 list-none m-0 p-0">
        {shown.map((c, i) => (
          <li key={`${c.user?.handle ?? c.name}-${i}`}>
            <ContributorAvatar c={c} />
          </li>
        ))}
      </ul>
      {data.total > shown.length && (
        <p className="mt-2 text-fh-sm text-fh-fg-muted">+ {data.total - shown.length} more</p>
      )}
    </SidebarSection>
  );
}
