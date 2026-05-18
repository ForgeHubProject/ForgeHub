import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useLocation } from "react-router-dom";
import { getRepo, listBranches, listIssues, listPulls } from "../api";
import { Header } from "../components/Header";
import type { BranchInfo, Issue, PullRequest, Repo, User } from "../types";
import { RepoCodeTab } from "./repo/RepoCodeTab";
import { RepoCommitsTab } from "./repo/RepoCommitsTab";
import { RepoIssuesTab } from "./repo/RepoIssuesTab";
import { RepoPullsTab } from "./repo/RepoPullsTab";
import { RepoReleasesTab } from "./repo/RepoReleasesTab";
import { RepoSettingsTab } from "./repo/RepoSettingsTab";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

type Tab = "code" | "issues" | "pulls" | "commits" | "releases" | "settings";

function tabFromPath(subpath: string): Tab {
  if (subpath.startsWith("issues")) return "issues";
  if (subpath.startsWith("pulls")) return "pulls";
  if (subpath.startsWith("commits")) return "commits";
  if (subpath.startsWith("releases")) return "releases";
  if (subpath.startsWith("settings")) return "settings";
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

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M7.429 1.525a6.593 6.593 0 011.142 0c.036.003.108.036.137.146l.289 1.105c.147.56.55.967.997 1.189.174.086.341.183.501.29.417.278.97.423 1.53.27l1.102-.303c.11-.03.175.016.195.046.219.31.41.641.573.989.014.03.023.109-.063.17l-.948.709c-.447.334-.629.847-.57 1.343.018.148.028.298.028.45s-.01.302-.028.45c-.059.496.123 1.01.57 1.344l.948.708c.086.061.077.14.063.17a6.38 6.38 0 01-.573.99c-.02.029-.086.075-.195.045l-1.103-.303c-.559-.153-1.112-.008-1.529.27-.16.107-.327.204-.5.29-.449.222-.851.628-.998 1.189l-.289 1.105c-.029.11-.101.143-.137.146a6.593 6.593 0 01-1.142 0c-.036-.003-.108-.036-.137-.146l-.289-1.105c-.147-.56-.55-.967-.997-1.189a4.502 4.502 0 01-.501-.29c-.417-.278-.97-.423-1.53-.27l-1.102.303c-.11.03-.175-.016-.195-.046a6.381 6.381 0 01-.573-.989c-.014-.03-.023-.109.063-.17l.948-.709c.447-.334.629-.847.57-1.343A4.502 4.502 0 012 8c0-.152.01-.302.028-.45.059-.496-.123-1.01-.57-1.344l-.948-.708c-.086-.061-.077-.14-.063-.17a6.38 6.38 0 01.573-.99c.02-.029.086-.075.195-.045l1.103.303c.559.153 1.112.008 1.529-.27.16-.107.327-.204.5-.29.449-.222.851-.628.998-1.189l.289-1.105c.029-.11.101-.143.137-.146zM8 0c-.236 0-.47.01-.701.03-.743.065-1.29.615-1.458 1.261l-.29 1.106c-.017.066-.078.158-.211.224a5.001 5.001 0 00-.498.29c-.12.079-.247.112-.37.08L3.37 2.687c-.648-.178-1.32.03-1.711.567a7.9 7.9 0 00-.71 1.227c-.285.632-.109 1.355.353 1.824l.95.71c.056.043.128.147.128.285a4.5 4.5 0 000 .9c0 .138-.072.242-.129.285l-.95.71c-.461.469-.637 1.192-.352 1.824.2.446.437.87.71 1.227.39.537 1.063.745 1.711.567l1.103-.303c.123-.032.25 0 .37.08.16.107.327.204.497.29.134.066.195.158.212.224l.29 1.106c.167.646.715 1.196 1.457 1.26a8.094 8.094 0 001.402 0c.743-.064 1.29-.614 1.458-1.26l.29-1.106c.017-.066.078-.158.211-.224a5 5 0 00.498-.29c.12-.079.247-.112.37-.08l1.103.303c.648.178 1.32-.03 1.711-.567.273-.357.51-.781.71-1.227.285-.632.109-1.355-.353-1.824l-.95-.71c-.056-.043-.128-.147-.128-.285a4.5 4.5 0 000-.9c0-.138.072-.242.129-.285l.95-.71c.461-.469.637-1.192.352-1.824a7.9 7.9 0 00-.71-1.227c-.39-.537-1.063-.745-1.711-.567l-1.103.303c-.123.032-.25 0-.37-.08a5 5 0 00-.497-.29c-.134-.066-.195-.158-.212-.224L9.16 1.29C8.992.644 8.444.094 7.701.03A8.094 8.094 0 008 0zM6.5 8a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zM8 5a3 3 0 100 6 3 3 0 000-6z" />
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
        className="flex items-center gap-1.5 px-4 py-3 text-sm border-b-2 transition-colors whitespace-nowrap no-underline"
        style={{
          borderBottomColor: isActive ? "#fd8c73" : "transparent",
          color: isActive ? "#1f2328" : "#656d76",
          fontWeight: isActive ? 600 : 400,
        }}
        onMouseEnter={(e) => { if (!isActive) { (e.currentTarget as HTMLElement).style.color = "#1f2328"; (e.currentTarget as HTMLElement).style.borderBottomColor = "#d0d7de"; } }}
        onMouseLeave={(e) => { if (!isActive) { (e.currentTarget as HTMLElement).style.color = "#656d76"; (e.currentTarget as HTMLElement).style.borderBottomColor = "transparent"; } }}
      >
        {icon}
        {label}
        {count != null && count > 0 && (
          <span className="counter ml-0.5">{count}</span>
        )}
      </Link>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gh-bg">
        <Header user={user} onLogout={onLogout} token={token} />
        <div className="flex items-center justify-center py-32 text-gh-muted">Loading…</div>
      </div>
    );
  }

  if (error || !repo) {
    return (
      <div className="min-h-screen bg-gh-bg">
        <Header user={user} onLogout={onLogout} token={token} />
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
      <Header user={user} onLogout={onLogout} token={token} />

      {/* Repo header */}
      <div className="bg-gh-canvas border-b border-gh-border">
        <div className="max-w-[1280px] mx-auto px-4 pt-4">
          {/* Breadcrumb row */}
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted flex-shrink-0">
              <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
            </svg>
            <Link to="/" className="text-base font-semibold text-gh-accent hover:underline">
              {user.handle}
            </Link>
            <span className="text-gh-muted text-base font-light">/</span>
            <Link to={base} className="text-base font-semibold text-gh-accent hover:underline">
              {repo.name}
            </Link>
            <span className={`badge ml-0.5 ${repo.visibility === "private" ? "border-gh-border text-gh-muted" : "border-gh-border text-gh-muted"}`}>
              {repo.visibility === "private" ? <><LockIcon />&nbsp;Private</> : "Public"}
            </span>
          </div>

          {repo.description && (
            <p className="text-sm text-gh-muted mb-3">{repo.description}</p>
          )}

          {/* Tab bar */}
          <div className="flex items-stretch -mb-px overflow-x-auto gap-0">
            <TabLink tab="code" icon={<CodeIcon />} label="Code" />
            <TabLink tab="issues" icon={<IssueIcon />} label="Issues" count={openIssueCount} />
            <TabLink tab="pulls" icon={<PRIcon />} label="Pull requests" count={openPrCount} />
            <TabLink tab="commits" icon={<CommitIcon />} label="Commits" />
            <TabLink tab="releases" icon={<TagIcon />} label="Releases" />
            {user.handle === h && (
              <TabLink tab="settings" icon={<SettingsIcon />} label="Settings" />
            )}
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
            splat={splat}
          />
        )}
        {activeTab === "issues" && (
          <RepoIssuesTab
            token={token}
            handle={h}
            repoName={r}
            user={user}
            splat={splat}
          />
        )}
        {activeTab === "pulls" && (
          <RepoPullsTab
            token={token}
            handle={h}
            repoName={r}
            user={user}
            splat={splat}
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
        {activeTab === "settings" && user.handle === h && (
          <RepoSettingsTab token={token} handle={h} repoName={r} user={user} />
        )}
      </div>
    </div>
  );
}
