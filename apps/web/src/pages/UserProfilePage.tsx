import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getPublicProfile, getUserRepos, updateMyProfile } from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { PublicProfile, Repo, User } from "../types";
import {
  Avatar,
  Button,
  Dialog,
  EmptyState,
  Field,
  Icons,
  Skeleton,
  TextInput,
  Textarea,
  useToast,
} from "../ui";
import { CalendarIcon, LinkIcon, LocationIcon, RepoIcon, RepoRow, RowList } from "./listShared";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

const EDIT_FORM_ID = "edit-profile-form";

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
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [bio, setBio] = useState(profile.bio ?? "");
  const [location, setLocation] = useState(profile.location ?? "");
  const [website, setWebsite] = useState(profile.website ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await updateMyProfile(token, { displayName, bio, location, website });
      onSave({ ...profile, ...res.user });
      toast("Profile updated", { tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

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
      <form id={EDIT_FORM_ID} onSubmit={save} className="flex flex-col gap-4">
        <Field label="Name" htmlFor="edit-name">
          {(id) => (
            <TextInput
              id={id}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your display name"
              maxLength={64}
            />
          )}
        </Field>
        <Field label="Bio" htmlFor="edit-bio" hint={`${bio.length}/200`}>
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell people a little about yourself"
              maxLength={200}
            />
          )}
        </Field>
        <Field label="Location" htmlFor="edit-location">
          {(id) => (
            <TextInput
              id={id}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="City, Country"
              maxLength={100}
            />
          )}
        </Field>
        <Field label="Website" htmlFor="edit-website">
          {(id) => (
            <TextInput
              id={id}
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://yoursite.com"
              maxLength={200}
            />
          )}
        </Field>
        {error && (
          <p className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>
        )}
      </form>
    </Dialog>
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

export function UserProfilePage({ token, user, onLogout }: Props) {
  const { handle } = useParams<{ handle: string }>();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);

  const isOwnProfile = user.handle === handle;

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    setFilter("");
    Promise.all([getPublicProfile(token, handle), getUserRepos(token, handle)])
      .then(([prof, repoData]) => {
        setProfile(prof);
        setRepos(repoData.repos);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "User not found"))
      .finally(() => setLoading(false));
  }, [token, handle]);

  const displayName = profile?.displayName || handle || "";

  const filteredRepos = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
    );
  }, [filter, repos]);

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8">
        {loading && <ProfileSkeleton />}

        {!loading && error && (
          <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-16 text-center">
            <p className="text-fh-lg font-semibold text-fh-fg">User not found</p>
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
              <Avatar name={displayName} src={null} size={240} className="max-w-full" />

              <div className="mt-4">
                {profile.displayName && (
                  <h1 className="text-fh-2xl font-semibold leading-tight text-fh-fg">
                    {profile.displayName}
                  </h1>
                )}
                <p className="text-fh-xl text-fh-fg-muted">@{profile.handle}</p>
              </div>

              {isOwnProfile && (
                <Button variant="default" block className="mt-4" onClick={() => setShowEdit(true)}>
                  Edit profile
                </Button>
              )}

              <div className="mt-4 space-y-2 text-fh-base">
                {profile.bio && <p className="text-fh-fg">{profile.bio}</p>}

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

                <div className="flex items-center gap-2 text-fh-fg-muted">
                  <CalendarIcon size={14} className="shrink-0" />
                  <span>Joined {joinedLabel(profile.createdAt)}</span>
                </div>
              </div>
            </aside>

            {/* Main — repositories */}
            <main className="min-w-0 flex-1">
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-fh-border pb-4">
                <h2 className="flex items-center gap-2 text-fh-lg font-semibold text-fh-fg">
                  <RepoIcon className="text-fh-fg-muted" />
                  Repositories
                  <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full bg-fh-neutral-muted px-1.5 text-fh-xs font-semibold text-fh-fg-muted">
                    {repos.length}
                  </span>
                </h2>
                {repos.length > 0 && (
                  <div className="relative ml-auto w-full sm:w-56">
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
              ) : filteredRepos.length === 0 ? (
                <EmptyState
                  bordered
                  icon={<Icons.SearchIcon size={28} />}
                  title="No matching repositories"
                  description={`No repository matches “${filter.trim()}”.`}
                  actions={
                    <Button variant="default" onClick={() => setFilter("")}>
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
