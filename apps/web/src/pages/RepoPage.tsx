import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getRepo, listBranches, listTree, listCommits, listIssues, listPulls, listReleases } from "../api";
import { Header } from "../components/Header";
import type { BranchInfo, CommitInfo, Issue, PullRequest, Release, Repo, TreeEntry, User } from "../types";
import { RepoCodeTab } from "./repo/RepoCodeTab";
import { RepoCommitsTab } from "./repo/RepoCommitsTab";
import { RepoIssuesTab } from "./repo/RepoIssuesTab";
import { RepoPullsTab } from "./repo/RepoPullsTab";
import { RepoReleasesTab } from "./repo/RepoReleasesTab";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

type Tab = "code" | "issues" | "pulls" | "commits" | "releases";

function tabFromPath(subpath: string): Tab {
  if (subpath.startsWith("issues")) return "issues";
  if (subpath.startsWith("pulls")) return "pulls";
  if (subpath.startsWith("commits")) return "commits";
  if (subpath.startsWith("releases")) return "releases";
  return "code";
}

function CodeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06l-4.25-4.25z" />
    </svg>
  );
}

function IssueIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
      <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
    </svg>
  );
}

function PRIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M4 4v2h-.25A1.75 1.75 0 002 7.75v5.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 13.25v-5.5A1.75 1.75 0 0012.25 6H12V4a4 4 0 10-8 0zm6.5 2V4a2.5 2.5 0 00-5 0v2h5zM12 7.5h.25a.25.25 0 01.25.25v5.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-5.5a.25.25 0 01.25-.25H12z" />
    </svg>
  );
}

function CloneButton({ handle, repoName }: { handle: string; repoName: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/git/${handle}/${repoName}.git`;

  function copy() {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      className="btn-default flex items-center gap-2 text-gh-sm px-3 py-1.5"
      onClick={copy}
    >
      {copied ? "Copied!" : "Clone"}
    </button>
  );
}

export function RepoPage({ token, user, onLogout }: Props) {
  const { handle, repoName, "*": splat = "" } = useParams<{ handle: string; repoName: string; "*": string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = tabFromPath(splat);

  const [repo, setRepo] = useState<Repo | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [currentRef, setCurrentRef] = useState<string>("");

  const [openIssueCount, setOpenIssueCount] = useState<number | null>(null);
  const [openPrCount, setOpenPrCount] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const h = handle!;
  const r = repoName!;

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      getRepo(token, h, r),
      listBranches(token, h, r),
    ])
      .then(([repoData, branchData]) => {
        setRepo(repoData);
        setBranches(branchData.branches);
        setDefaultBranch(branchData.defaultBranch);
        setCurrentRef(branchData.defaultBranch);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));

    listIssues(token, h, r, "open")
      .then((d) => setOpenIssueCount(d.issues.length))
      .catch(() => {});

    listPulls(token, h, r, "open")
      .then((d) => setOpenPrCount(d.pulls.length))
      .catch(() => {});
  }, [token, h, r]);

  const base = `/${h}/${r}`;

  function TabLink({ tab, icon, label, count }: { tab: Tab; icon: React.ReactNode; label: string; count?: number | null }) {
    const isActive = activeTab === tab;
    return (
      <Link
        to={tab === "code" ? base : `${base}/${tab}`}
        className={`flex items-center gap-1.5 px-3 py-2 text-gh-sm border-b-2 transition-colors whitespace-nowrap no-underline ${
          isActive
            ? "border-gh-accent text-gh-text font-semibold"
            : "border-transparent text-gh-muted hover:text-gh-text hover:border-gh-border"
        }`}
      >
        {icon}
        {label}
        {count != null && (
          <span className="counter ml-0.5">{count}</span>
        )}
      </Link>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gh-bg">
        <Header user={user} onLogout={onLogout} />
        <div className="flex items-center justify-center py-32 text-gh-muted">Loading…</div>
      </div>
    );
  }

  if (error || !repo) {
    return (
      <div className="min-h-screen bg-gh-bg">
        <Header user={user} onLogout={onLogout} />
        <div className="max-w-4xl mx-auto px-4 py-16 text-center">
          <p className="text-gh-xl font-semibold text-gh-text">Repository not found</p>
          <p className="text-gh-muted mt-2">{error ?? "This repository does not exist or you do not have access."}</p>
          <Link to="/" className="btn-default mt-4 inline-flex">Back to dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gh-bg">
      <Header user={user} onLogout={onLogout} />

      {/* Repo header */}
      <div className="border-b border-gh-border bg-gh-canvas">
        <div className="max-w-[1280px] mx-auto px-4">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 py-3 text-gh-lg flex-wrap">
            <Link to="/" className="text-gh-accent font-semibold hover:underline no-underline">
              {user.handle}
            </Link>
            <span className="text-gh-muted">/</span>
            <Link to={base} className="text-gh-accent font-semibold hover:underline no-underline">
              {repo.name}
            </Link>
            {repo.visibility === "private" && (
              <span className="badge border-gh-border text-gh-muted ml-1 flex items-center gap-1">
                <LockIcon /> Private
              </span>
            )}
          </div>

          {/* Tab bar */}
          <div className="flex items-center gap-1 -mb-px overflow-x-auto">
            <TabLink tab="code" icon={<CodeIcon />} label="Code" />
            <TabLink tab="issues" icon={<IssueIcon />} label="Issues" count={openIssueCount} />
            <TabLink tab="pulls" icon={<PRIcon />} label="Pull requests" count={openPrCount} />
            <TabLink tab="commits" icon={<CommitIcon />} label="Commits" />
            <TabLink tab="releases" icon={<TagIcon />} label="Releases" />
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-[1280px] mx-auto px-4 py-6">
        {activeTab === "code" && (
          <RepoCodeTab
            token={token}
            handle={h}
            repoName={r}
            repo={repo}
            branches={branches}
            defaultBranch={defaultBranch}
            currentRef={currentRef}
            onRefChange={setCurrentRef}
            splat={splat}
          />
        )}
        {activeTab === "commits" && (
          <RepoCommitsTab
            token={token}
            handle={h}
            repoName={r}
            defaultBranch={defaultBranch}
          />
        )}
        {activeTab === "issues" && (
          <RepoIssuesTab
            token={token}
            handle={h}
            repoName={r}
            user={user}
          />
        )}
        {activeTab === "pulls" && (
          <RepoPullsTab
            token={token}
            handle={h}
            repoName={r}
            user={user}
          />
        )}
        {activeTab === "releases" && (
          <RepoReleasesTab
            token={token}
            handle={h}
            repoName={r}
            user={user}
          />
        )}
      </div>
    </div>
  );
}
