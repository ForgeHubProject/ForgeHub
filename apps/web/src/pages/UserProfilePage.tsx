import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  avatarSrc,
  deleteAvatar,
  getActivity,
  getContributions,
  getPublicProfile,
  getReadme,
  getUserRepos,
  setBlocked,
  setFollowing,
  uploadAvatar,
} from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { ContributionHeatmap } from "../components/ContributionHeatmap";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import type { ActivityMonth, Contributions, PublicProfile, Repo, User } from "../types";
import {
  Avatar,
  Button,
  Dialog,
  EmptyState,
  Icons,
  Select,
  Skeleton,
  TabItem,
  TabNav,
  TextInput,
  useToast,
} from "../ui";
import { ContributionActivity, PeopleList, PinnedRepos, StarsList } from "./profileParts";
import { ProfileForm } from "./ProfileForm";
import { CalendarIcon, LinkIcon, LocationIcon, RepoIcon, RepoRow, RowList } from "./listShared";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
  /** Lets an avatar change on one's own profile update the header immediately. */
  onUserChange?: (u: User) => void;
};

/** Accepted avatar image types (mirrors the API's magic-byte validation). */
const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp";

const EDIT_FORM_ID = "edit-profile-form";

function OrgIcon() {
  return (
    <svg aria-hidden width={14} height={14} viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
      <path d="M1.75 16A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0h8.5C11.216 0 12 .784 12 1.75v12.5c0 .085-.006.168-.018.25h2.268a.25.25 0 0 0 .25-.25V8.285a.25.25 0 0 0-.111-.208l-1.055-.703a.749.749 0 1 1 .832-1.248l1.055.703c.487.325.779.871.779 1.456v5.965A1.75 1.75 0 0 1 14.25 16h-3.5a.766.766 0 0 1-.197-.026c-.099.017-.2.026-.303.026h-3a.75.75 0 0 1-.75-.75V14h-1v1.25a.75.75 0 0 1-.75.75Zm-.25-1.75c0 .138.112.25.25.25H4v-1.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .75.75v1.25h2.25a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25ZM3.75 6h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM3 3.75A.75.75 0 0 1 3.75 3h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 3.75Zm4 3A.75.75 0 0 1 7.75 6h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 7 6.75ZM7.75 3h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM3 9.75A.75.75 0 0 1 3.75 9h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 9.75ZM7.75 9h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5Z" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M0 1.75A.75.75 0 01.75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0111.006 1h4.245a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75h-4.507a2.25 2.25 0 00-1.591.659l-.622.621a.75.75 0 01-1.062 0l-.622-.621A2.25 2.25 0 005.258 13H.75a.75.75 0 01-.75-.75V1.75zm7.75 3.19v8.502A3.75 3.75 0 0111.006 11.5h3.744V2.5h-3.5a2.25 2.25 0 00-2.25 2.25v.19zm-1.5 8.502V4.75A2.25 2.25 0 004.75 2.5H1.25v9h4.008a3.75 3.75 0 01.992.132V13.442z" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694v.001z" />
    </svg>
  );
}

function joinedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function EditProfileDialog({
  token,
  profile,
  onSave,
  onClose,
}: {
  token: string;
  profile: PublicProfile;
  onSave: (updated: PublicProfile) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      onClose={saving ? () => {} : onClose}
      title="Edit profile"
      footer={
        <>
          <Button variant="default" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={EDIT_FORM_ID} variant="primary" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <ProfileForm token={token} profile={profile} formId={EDIT_FORM_ID} onSaved={onSave} onSavingChange={setSaving} />
    </Dialog>
  );
}

function PrivateNotice({ handle }: { handle: string }) {
  return (
    <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-10 text-center">
      <p className="text-fh-base font-semibold text-fh-fg">This profile is private</p>
      <p className="mt-1 text-fh-sm text-fh-fg-muted">@{handle} keeps their activity, stars and followers to themselves.</p>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-8 sm:flex-row">
      <aside className="w-full flex-shrink-0 sm:w-[296px]">
        <Skeleton variant="circle" width={240} height={240} className="max-w-full" />
        <Skeleton variant="text" width="60%" className="mt-4 h-6" />
        <Skeleton variant="text" width="40%" className="mt-2" />
      </aside>
      <main className="min-w-0 flex-1 space-y-3">
        <Skeleton width="100%" height={38} />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} width="100%" height={72} />
        ))}
      </main>
    </div>
  );
}

export function UserProfilePage({ token, user, onLogout, onUserChange }: Props) {
  const { handle } = useParams<{ handle: string }>();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [readme, setReadme] = useState<{ path: string; content: string } | null>(null);
  const [contrib, setContrib] = useState<Contributions | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const isOwnProfile = user.handle === handle;
  // GitHub's profile tabs (#257), kept in the URL.
  const [params] = useSearchParams();
  const tabParam = params.get("tab") ?? "";
  const tab = ["repositories", "stars", "followers", "following"].includes(tabParam) ? tabParam : "overview";
  const [repoType, setRepoType] = useState("all");
  const [repoSort, setRepoSort] = useState("updated");
  const [followBusy, setFollowBusy] = useState(false);

  async function toggleBlock() {
    if (!profile || !handle) return;
    try {
      const res = await setBlocked(token, handle, !profile.viewerBlocks);
      setProfile({ ...profile, viewerBlocks: res.blocked, viewerFollows: res.blocked ? false : profile.viewerFollows });
      toast(res.blocked ? `Blocked @${profile.handle}` : `Unblocked @${profile.handle}`, { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't update the block", { tone: "danger" });
    }
  }

  async function toggleFollow() {
    if (!profile || !handle) return;
    setFollowBusy(true);
    try {
      const res = await setFollowing(token, handle, !profile.viewerFollows);
      setProfile({ ...profile, viewerFollows: res.following, followers: res.followers });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't update following", { tone: "danger" });
    } finally {
      setFollowBusy(false);
    }
  }

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    setFilter("");
    setReadme(null);
    setContrib(null);
    Promise.all([getPublicProfile(token, handle), getUserRepos(token, handle)])
      .then(([prof, repoData]) => {
        setProfile(prof);
        setRepos(repoData.repos);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load profile"))
      .finally(() => setLoading(false));
  }, [token, handle]);

  // Profile README = the README of the repo named exactly the handle (e.g.
  // alice/alice), reusing the repo README endpoint (which already enforces
  // visibility). Absent/unreadable ⇒ simply nothing rendered.
  useEffect(() => {
    if (!handle) return;
    let live = true;
    getReadme(token, handle, handle)
      .then((r) => live && setReadme({ path: r.path, content: r.content }))
      .catch(() => live && setReadme(null));
    return () => {
      live = false;
    };
  }, [token, handle]);

  // Contribution calendar and the activity under it: the last ~12 months, or a
  // calendar year from the picker (#257). Best-effort.
  const [year, setYear] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityMonth[] | null>(null);
  useEffect(() => setYear(null), [handle]);
  useEffect(() => {
    if (!handle) return;
    let live = true;
    const from = year ? `${year}-01-01T00:00:00.000Z` : undefined;
    const to = year ? (year === new Date().getUTCFullYear() ? new Date().toISOString() : `${year}-12-31T23:59:59.999Z`) : undefined;
    setActivity(null);
    getContributions(token, handle, from, to)
      .then((c) => live && setContrib(c))
      .catch(() => live && setContrib(null));
    getActivity(token, handle, from, to)
      .then((a) => live && setActivity(a.months))
      .catch(() => live && setActivity([]));
    return () => {
      live = false;
    };
  }, [token, handle, year]);

  async function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file || !profile) return;
    setAvatarBusy(true);
    try {
      const { avatarKey } = await uploadAvatar(token, file);
      setProfile({ ...profile, avatarKey });
      if (isOwnProfile) onUserChange?.({ ...user, avatarKey });
      toast("Avatar updated", { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Upload failed", { tone: "danger" });
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleAvatarRemove() {
    if (!profile) return;
    setAvatarBusy(true);
    try {
      await deleteAvatar(token);
      setProfile({ ...profile, avatarKey: null });
      if (isOwnProfile) onUserChange?.({ ...user, avatarKey: null });
      toast("Avatar removed", { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Remove failed", { tone: "danger" });
    } finally {
      setAvatarBusy(false);
    }
  }

  const displayName = profile?.displayName || handle || "";
  // Someone else's private profile (#257): activity, stars and followers stay hidden.
  const hidden = !!profile?.privateProfile && !isOwnProfile;
  const years = useMemo(() => {
    const first = profile ? new Date(profile.createdAt).getUTCFullYear() : new Date().getUTCFullYear();
    const out: number[] = [];
    for (let y = new Date().getUTCFullYear(); y >= first; y--) out.push(y);
    return out;
  }, [profile]);

  const filteredRepos = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = repos.filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)) &&
        (repoType === "all" ||
          (repoType === "sources" && !r.parent) ||
          (repoType === "forks" && !!r.parent) ||
          (repoType === "archived" && !!r.archived)),
    );
    const order: Record<string, (a: Repo, b: Repo) => number> = {
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      name: (a, b) => a.name.localeCompare(b.name),
      stars: (a, b) => (b.starCount ?? 0) - (a.starCount ?? 0),
    };
    return [...matched].sort(order[repoSort] ?? order.updated);
  }, [filter, repos, repoType, repoSort]);
  const filtering = filter.trim() !== "" || repoType !== "all";

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8">
        {loading && <ProfileSkeleton />}

        {!loading && error && (
          <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-16 text-center">
            <p className="text-fh-lg font-semibold text-fh-fg">Couldn't load this profile</p>
            <p className="mt-1 text-fh-base text-fh-fg-muted">{error}</p>
            <Link to="/" className="mt-4 inline-block no-underline">
              <Button variant="default">Back to dashboard</Button>
            </Link>
          </div>
        )}

        {!loading && !error && profile && (
          <div className="flex flex-col gap-8 sm:flex-row">
            {/* Left sidebar — identity */}
            <aside className="w-full flex-shrink-0 sm:w-[296px]">
              <Avatar
                name={displayName}
                src={avatarSrc(profile.handle, profile.avatarKey)}
                size={240}
                className="max-w-full"
              />

              {isOwnProfile && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept={AVATAR_ACCEPT}
                    className="hidden"
                    onChange={handleAvatarFile}
                  />
                  <Button
                    size="sm"
                    variant="default"
                    loading={avatarBusy}
                    onClick={() => fileRef.current?.click()}
                  >
                    {profile.avatarKey ? "Change photo" : "Upload photo"}
                  </Button>
                  {profile.avatarKey && (
                    <Button size="sm" variant="invisible" disabled={avatarBusy} onClick={handleAvatarRemove}>
                      Remove
                    </Button>
                  )}
                </div>
              )}

              <div className="mt-4">
                {profile.displayName && (
                  <h1 className="text-fh-2xl font-semibold leading-tight text-fh-fg">
                    {profile.displayName}
                  </h1>
                )}
                <p className="text-fh-xl text-fh-fg-muted">
                  @{profile.handle}
                  {profile.pronouns && <span className="text-fh-base"> · {profile.pronouns}</span>}
                </p>
                {profile.status && (
                  <p className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-fh-border bg-fh-surface px-3 py-1 text-fh-sm text-fh-fg">
                    {profile.status.emoji && <span aria-hidden>{profile.status.emoji}</span>}
                    <span className="truncate">{profile.status.text}</span>
                  </p>
                )}
              </div>

              {isOwnProfile ? (
                <Button variant="default" block className="mt-4" onClick={() => setShowEdit(true)}>
                  Edit profile
                </Button>
              ) : profile.viewerBlocks ? (
                <Button variant="default" block className="mt-4" onClick={() => void toggleBlock()}>
                  Unblock
                </Button>
              ) : (
                <Button variant={profile.viewerFollows ? "default" : "primary"} block className="mt-4" loading={followBusy} onClick={() => void toggleFollow()}>
                  {profile.viewerFollows ? "Unfollow" : "Follow"}
                </Button>
              )}

              {profile.followers != null && <p className="mt-3 text-fh-sm text-fh-fg-muted">
                <Link to="?tab=followers" className="text-fh-fg-muted no-underline hover:text-fh-accent-fg">
                  <span className="font-semibold text-fh-fg">{profile.followers ?? 0}</span> {profile.followers === 1 ? "follower" : "followers"}
                </Link>
                {" · "}
                <Link to="?tab=following" className="text-fh-fg-muted no-underline hover:text-fh-accent-fg">
                  <span className="font-semibold text-fh-fg">{profile.following ?? 0}</span> following
                </Link>
              </p>}

              <div className="mt-4 space-y-2 text-fh-base">
                {profile.bio && <p className="text-fh-fg">{profile.bio}</p>}

                {profile.company && (
                  <div className="flex items-center gap-2 text-fh-fg-muted">
                    <OrgIcon />
                    <span>{profile.company}</span>
                  </div>
                )}

                {profile.location && (
                  <div className="flex items-center gap-2 text-fh-fg-muted">
                    <LocationIcon size={14} className="shrink-0" />
                    <span>{profile.location}</span>
                  </div>
                )}

                {profile.website && (
                  <div className="flex items-center gap-2 text-fh-fg-muted">
                    <LinkIcon size={14} className="shrink-0" />
                    <a
                      href={profile.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="truncate text-fh-accent-fg hover:underline"
                    >
                      {profile.website.replace(/^https?:\/\//, "")}
                    </a>
                  </div>
                )}

                {(profile.socialLinks ?? []).map((l) => (
                  <div key={l} className="flex items-center gap-2 text-fh-fg-muted">
                    <LinkIcon size={14} className="shrink-0" />
                    <a href={l} target="_blank" rel="noopener noreferrer me" className="truncate text-fh-accent-fg hover:underline">
                      {l.replace(/^https?:\/\//, "")}
                    </a>
                  </div>
                ))}

                <div className="flex items-center gap-2 text-fh-fg-muted">
                  <CalendarIcon size={14} className="shrink-0" />
                  <span>Joined {joinedLabel(profile.createdAt)}</span>
                </div>
              </div>

              {!isOwnProfile && !profile.viewerBlocks && (
                <button type="button" onClick={() => void toggleBlock()} className="mt-4 border-t border-fh-border-muted pt-3 text-fh-sm text-fh-fg-muted hover:text-fh-danger-fg">
                  Block user
                </button>
              )}
            </aside>

            {/* Main — GitHub's profile tabs */}
            <main className="min-w-0 flex-1">
              <TabNav aria-label="Profile" className="mb-6">
                <TabItem to="?" active={tab === "overview"} icon={<BookIcon />}>Overview</TabItem>
                <TabItem to="?tab=repositories" active={tab === "repositories"} icon={<RepoIcon size={16} />} count={repos.length}>Repositories</TabItem>
                <TabItem to="?tab=stars" active={tab === "stars"} icon={<StarIcon />}>Stars</TabItem>
              </TabNav>

              {tab === "overview" && (
                <>
                  {/* Profile README (from the handle/handle repo, when present + readable) */}
                  {readme && (
                    <div className="mb-6 overflow-hidden rounded-md border border-fh-border bg-fh-surface">
                      <div className="flex items-center gap-2 border-b border-fh-border bg-fh-canvas px-4 py-2.5">
                        <RepoIcon size={14} className="text-fh-fg-muted" />
                        <span className="text-fh-sm font-semibold text-fh-fg">
                          {profile.handle}/{profile.handle}
                        </span>
                      </div>
                      <div className="px-6 py-6 md:px-8">
                        <MarkdownRenderer content={readme.content} />
                      </div>
                    </div>
                  )}

                  <PinnedRepos token={token} handle={profile.handle} own={isOwnProfile} candidates={repos} />

                  {/* Contribution calendar, the activity under it, and the year picker */}
                  {hidden ? (
                    <PrivateNotice handle={profile.handle} />
                  ) : (
                    contrib && (
                      <div className="flex flex-col gap-4 lg:flex-row">
                        <div className="min-w-0 flex-1">
                          <section className="mb-6" aria-label="Contributions">
                            <h2 className="mb-3 text-fh-base font-semibold text-fh-fg">
                              {contrib.total} {contrib.total === 1 ? "contribution" : "contributions"} {year ? `in ${year}` : "in the last year"}
                            </h2>
                            <div className="rounded-md border border-fh-border bg-fh-surface p-4">
                              <ContributionHeatmap data={contrib} />
                            </div>
                          </section>
                          <section aria-label="Contribution activity">
                            <h2 className="mb-3 text-fh-base font-semibold text-fh-fg">Contribution activity</h2>
                            {activity ? <ContributionActivity key={year ?? "last"} months={activity} /> : <Skeleton width="100%" height={72} />}
                          </section>
                        </div>
                        {years.length > 1 && (
                          <nav aria-label="Contribution years" className="flex flex-row flex-wrap gap-1 lg:w-24 lg:flex-col">
                            {years.map((y) => (
                              <button
                                key={y}
                                type="button"
                                aria-current={year === y ? "true" : undefined}
                                onClick={() => setYear(year === y ? null : y)}
                                className={
                                  year === y
                                    ? "rounded-md bg-fh-accent-emphasis px-3 py-1.5 text-left text-fh-sm font-semibold text-fh-on-emphasis"
                                    : "rounded-md px-3 py-1.5 text-left text-fh-sm text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg"
                                }
                              >
                                {y}
                              </button>
                            ))}
                          </nav>
                        )}
                      </div>
                    )
                  )}

                </>
              )}

              {tab === "repositories" && (
                <>
                  <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-fh-border pb-4">
                    {repos.length > 0 && (
                      <div className="relative w-full sm:flex-1">
                        <Icons.SearchIcon
                          size={14}
                          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fh-fg-muted"
                        />
                        <TextInput
                          sizing="sm"
                          className="pl-8"
                          placeholder="Find a repository…"
                          aria-label="Find a repository"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                        />
                      </div>
                    )}
                    {repos.length > 0 && (
                      <div className="flex gap-2">
                        <Select sizing="sm" aria-label="Type" value={repoType} onChange={(e) => setRepoType(e.target.value)}>
                          <option value="all">Type: All</option>
                          <option value="sources">Sources</option>
                          <option value="forks">Forks</option>
                          <option value="archived">Archived</option>
                        </Select>
                        <Select sizing="sm" aria-label="Sort" value={repoSort} onChange={(e) => setRepoSort(e.target.value)}>
                          <option value="updated">Sort: Last updated</option>
                          <option value="name">Name</option>
                          <option value="stars">Stars</option>
                        </Select>
                      </div>
                    )}
                  </div>

                  {repos.length === 0 ? (
                    <EmptyState
                      bordered
                      icon={<RepoIcon size={28} />}
                      title={isOwnProfile ? "You don't have any repositories yet" : "No repositories to show"}
                      description={
                        isOwnProfile
                          ? "When you create repositories, they'll show up here on your profile."
                          : `@${profile.handle} doesn't have any public repositories yet.`
                      }
                    />
                  ) : filteredRepos.length === 0 && filtering ? (
                    <EmptyState
                      bordered
                      icon={<Icons.SearchIcon size={28} />}
                      title="No matching repositories"
                      description={filter.trim() ? `No repository matches “${filter.trim()}”.` : "No repository of this type."}
                      actions={
                        <Button variant="default" onClick={() => { setFilter(""); setRepoType("all"); }}>
                          Clear filter
                        </Button>
                      }
                    />
                  ) : (
                    <RowList aria-label={`Repositories owned by ${profile.handle}`}>
                      {filteredRepos.map((repo) => (
                        <RepoRow
                          key={repo.id}
                          to={`/${repo.ownerHandle ?? profile.handle}/${repo.name}`}
                          name={repo.name}
                          description={repo.description}
                          visibility={repo.visibility}
                          updatedAt={repo.updatedAt}
                          topics={repo.topics}
                        />
                      ))}
                    </RowList>
                  )}

                </>
              )}

              {tab === "stars" && (hidden ? <PrivateNotice handle={profile.handle} /> : <StarsList token={token} handle={profile.handle} />)}
              {(tab === "followers" || tab === "following") && hidden && <PrivateNotice handle={profile.handle} />}
              {(tab === "followers" || tab === "following") && !hidden && (
                <>
                  <h2 className="mb-3 text-fh-lg font-semibold text-fh-fg">{tab === "followers" ? "Followers" : "Following"}</h2>
                  <PeopleList token={token} handle={profile.handle} kind={tab} />
                </>
              )}
            </main>
          </div>
        )}
      </div>

      <Footer />

      {showEdit && profile && (
        <EditProfileDialog
          token={token}
          profile={profile}
          onSave={(updated) => {
            setProfile(updated);
            setShowEdit(false);
          }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </div>
  );
}
