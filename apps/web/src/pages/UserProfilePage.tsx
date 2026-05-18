import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getPublicProfile, getUserRepos, updateMyProfile } from "../api";
import { Header } from "../components/Header";
import type { PublicProfile, Repo, User } from "../types";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

function Avatar({ name, size = "lg" }: { name: string; size?: "sm" | "lg" }) {
  const sz = size === "lg" ? "w-64 h-64 text-7xl rounded-2xl" : "w-16 h-16 text-2xl rounded-xl";
  return (
    <div className={`${sz} bg-gh-accent flex items-center justify-center text-white font-semibold flex-shrink-0`}>
      {name[0]?.toUpperCase()}
    </div>
  );
}

function EditProfileModal({ token, profile, onSave, onClose }: {
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

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await updateMyProfile(token, { displayName, bio, location, website });
      onSave({ ...profile, ...res.user });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-gh-canvas border border-gh-border rounded-xl w-full max-w-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gh-border">
          <h2 className="text-base font-semibold text-gh-text">Edit profile</h2>
          <button className="text-gh-muted hover:text-gh-text bg-transparent border-none cursor-pointer p-1 rounded" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          </button>
        </div>
        <form onSubmit={save} className="px-6 py-5 flex flex-col gap-4">
          <div className="form-group">
            <label className="label">Name</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your display name" maxLength={64} />
          </div>
          <div className="form-group">
            <label className="label">Bio</label>
            <textarea
              className="input resize-none"
              rows={3}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell people a little about yourself"
              maxLength={200}
            />
            <p className="text-xs text-gh-muted mt-1">{bio.length}/200</p>
          </div>
          <div className="form-group">
            <label className="label">Location</label>
            <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City, Country" maxLength={100} />
          </div>
          <div className="form-group">
            <label className="label">Website</label>
            <input className="input" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://yoursite.com" maxLength={200} />
          </div>
          {error && <p className="text-gh-danger text-sm bg-gh-danger-muted rounded-md px-3 py-2">{error}</p>}
          <div className="flex justify-end gap-2 pt-2 border-t border-gh-border">
            <button type="button" className="btn-default" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary px-4" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RepoCard({ repo, showOwner }: { repo: Repo; showOwner?: boolean }) {
  const navigate = useNavigate();
  const target = `/${repo.ownerHandle ?? ""}/${repo.name}`;
  return (
    <div
      className="card p-4 cursor-pointer hover:border-gh-accent transition-colors"
      onClick={() => navigate(target)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-gh-accent font-semibold text-sm hover:underline">
              {showOwner ? `${repo.ownerHandle}/${repo.name}` : repo.name}
            </span>
            <span className={repo.visibility === "public" ? "badge-public" : "badge-private"} style={{ fontSize: 10 }}>
              {repo.visibility}
            </span>
          </div>
          {repo.description && (
            <p className="text-xs text-gh-muted mt-1 line-clamp-2">{repo.description}</p>
          )}
        </div>
      </div>
      <p className="text-xs text-gh-muted mt-3">Updated {new Date(repo.updatedAt).toLocaleDateString()}</p>
    </div>
  );
}

export function UserProfilePage({ token, user, onLogout }: Props) {
  const { handle } = useParams<{ handle: string }>();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);

  const isOwnProfile = user.handle === handle;

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    Promise.all([
      getPublicProfile(token, handle),
      getUserRepos(token, handle),
    ])
      .then(([prof, repoData]) => {
        setProfile(prof);
        setRepos(repoData.repos);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "User not found"))
      .finally(() => setLoading(false));
  }, [token, handle]);

  const displayName = profile?.displayName || handle || "";

  return (
    <div className="min-h-screen bg-gh-bg">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[1200px] mx-auto px-4 py-8">
        {loading && (
          <div className="flex gap-8 animate-pulse">
            <div className="w-64 flex-shrink-0">
              <div className="w-64 h-64 bg-gray-200 rounded-2xl mb-4" />
              <div className="h-6 bg-gray-200 rounded w-40 mb-2" />
              <div className="h-4 bg-gray-100 rounded w-28" />
            </div>
            <div className="flex-1 space-y-4">
              {[...Array(3)].map((_, i) => <div key={i} className="h-24 bg-gray-100 rounded-lg" />)}
            </div>
          </div>
        )}

        {error && (
          <div className="card p-12 text-center">
            <p className="text-gh-danger font-medium">{error}</p>
            <Link to="/" className="btn-default mt-4 inline-block">Go home</Link>
          </div>
        )}

        {!loading && profile && (
          <div className="flex flex-col sm:flex-row gap-8">
            {/* Left sidebar */}
            <aside className="w-full sm:w-[296px] flex-shrink-0">
              <Avatar name={displayName} size="lg" />

              <div className="mt-4">
                {profile.displayName && (
                  <h1 className="text-2xl font-semibold text-gh-text leading-tight">{profile.displayName}</h1>
                )}
                <p className="text-xl text-gh-muted">@{profile.handle}</p>
              </div>

              {isOwnProfile && (
                <button
                  className="btn-default w-full mt-3 text-sm"
                  onClick={() => setShowEdit(true)}
                >
                  Edit profile
                </button>
              )}

              <div className="mt-4 space-y-2 text-sm">
                {profile.bio && (
                  <p className="text-gh-text">{profile.bio}</p>
                )}

                {profile.location && (
                  <div className="flex items-center gap-2 text-gh-muted">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path fillRule="evenodd" d="M11.536 3.464a5 5 0 010 7.072L8 14.07l-3.536-3.534a5 5 0 117.072-7.072v.001zm1.06 8.132a6.5 6.5 0 10-9.192 0l3.535 3.536a1.5 1.5 0 002.122 0l3.535-3.536zM8 9a2 2 0 100-4 2 2 0 000 4z" />
                    </svg>
                    <span>{profile.location}</span>
                  </div>
                )}

                {profile.website && (
                  <div className="flex items-center gap-2 text-gh-muted">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path fillRule="evenodd" d="M7.775 3.275a.75.75 0 001.06 1.06l1.25-1.25a2 2 0 112.83 2.83l-2.5 2.5a2 2 0 01-2.83 0 .75.75 0 00-1.06 1.06 3.5 3.5 0 004.95 0l2.5-2.5a3.5 3.5 0 00-4.95-4.95l-1.25 1.25zm-4.69 9.64a2 2 0 010-2.83l2.5-2.5a2 2 0 012.83 0 .75.75 0 001.06-1.06 3.5 3.5 0 00-4.95 0l-2.5 2.5a3.5 3.5 0 004.95 4.95l1.25-1.25a.75.75 0 00-1.06-1.06l-1.25 1.25a2 2 0 01-2.83 0z" />
                    </svg>
                    <a
                      href={profile.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gh-accent hover:underline truncate"
                    >
                      {profile.website.replace(/^https?:\/\//, "")}
                    </a>
                  </div>
                )}

                <div className="flex items-center gap-2 text-gh-muted">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zM8 0a8 8 0 100 16A8 8 0 008 0zm.75 4.75a.75.75 0 00-1.5 0v3.5a.75.75 0 00.471.696l2.5 1a.75.75 0 00.558-1.392L8.75 7.843V4.75z" />
                  </svg>
                  <span>Joined {new Date(profile.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
                </div>
              </div>
            </aside>

            {/* Main content */}
            <main className="flex-1 min-w-0">
              <div className="tab-nav mb-4">
                <span className="tab-item-active">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
                  </svg>
                  Repositories
                  <span className="counter">{repos.length}</span>
                </span>
              </div>

              {repos.length === 0 ? (
                <div className="card p-12 text-center text-gh-muted">
                  <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor" className="mx-auto mb-3 opacity-40">
                    <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9z" />
                  </svg>
                  <p className="text-sm">{isOwnProfile ? "You don't have any repositories yet." : "No public repositories."}</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {repos.map((repo) => (
                    <RepoCard key={repo.id} repo={repo} />
                  ))}
                </div>
              )}
            </main>
          </div>
        )}
      </div>

      {showEdit && profile && (
        <EditProfileModal
          token={token}
          profile={profile}
          onSave={(updated) => { setProfile(updated); setShowEdit(false); }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </div>
  );
}
