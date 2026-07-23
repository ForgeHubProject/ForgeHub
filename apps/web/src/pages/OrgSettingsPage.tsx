import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  addOrgMember,
  addTeamMember,
  createTeam,
  deleteTeam,
  getOrg,
  getOrgTeams,
  grantTeamRepo,
  removeOrgMember,
  removeTeamMember,
  revokeTeamRepo,
  updateOrg,
  updateOrgMember,
} from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { OrgMember, OrgProfile, OrgRole, Repo, Team, User } from "../types";
import {
  Avatar,
  Badge,
  Button,
  Field,
  Select,
  Skeleton,
  TabItem,
  TabNav,
  TextInput,
  Textarea,
  useToast,
} from "../ui";
import { PersonIcon, RepoIcon } from "./listShared";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

type Tab = "members" | "teams" | "profile";

export function OrgSettingsPage({ token, user, onLogout }: Props) {
  const { handle } = useParams<{ handle: string }>();
  const { toast } = useToast();
  const [profile, setProfile] = useState<OrgProfile | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("members");

  const reloadOrg = useCallback(async () => {
    if (!handle) return;
    const p = await getOrg(token, handle);
    setProfile(p);
  }, [token, handle]);

  const reloadTeams = useCallback(async () => {
    if (!handle) return;
    const { teams: t } = await getOrgTeams(token, handle);
    setTeams(t);
  }, [token, handle]);

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    Promise.all([reloadOrg(), reloadTeams()])
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [handle, reloadOrg, reloadTeams]);

  function fail(e: unknown) {
    toast(e instanceof Error ? e.message : "Something went wrong", { tone: "danger" });
  }

  const org = profile?.org;
  const isOwner = org?.viewerRole === "OWNER";
  const members = profile?.members ?? [];
  const repos = profile?.repos ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="mx-auto w-full max-w-[960px] flex-1 px-4 py-8">
        {loading && (
          <div className="space-y-4">
            <Skeleton variant="text" width="30%" className="h-7" />
            <Skeleton width="100%" height={200} />
          </div>
        )}

        {!loading && (error || !org) && (
          <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-16 text-center">
            <p className="text-fh-lg font-semibold text-fh-fg">Organization not found</p>
            <p className="mt-1 text-fh-base text-fh-fg-muted">{error ?? "This organization does not exist."}</p>
          </div>
        )}

        {!loading && !error && org && !isOwner && (
          <div className="rounded-md border border-fh-border bg-fh-surface px-6 py-16 text-center">
            <p className="text-fh-lg font-semibold text-fh-fg">Owner access required</p>
            <p className="mt-1 text-fh-base text-fh-fg-muted">Only organization owners can manage settings.</p>
            <Link to={`/${org.handle}`} className="mt-4 inline-block no-underline">
              <Button variant="default">Back to {org.handle}</Button>
            </Link>
          </div>
        )}

        {!loading && !error && org && isOwner && (
          <>
            <div className="mb-6 flex items-center gap-3">
              <Avatar name={org.displayName || org.handle} square size={40} />
              <div>
                <h1 className="text-fh-xl font-semibold text-fh-fg">
                  <Link to={`/${org.handle}`} className="hover:text-fh-accent-fg no-underline">
                    {org.handle}
                  </Link>{" "}
                  <span className="text-fh-fg-muted">settings</span>
                </h1>
              </div>
            </div>

            <TabNav aria-label="Organization settings" className="mb-6">
              <TabItem active={tab === "members"} onClick={() => setTab("members")} icon={<PersonIcon size={15} />} count={members.length}>
                Members
              </TabItem>
              <TabItem active={tab === "teams"} onClick={() => setTab("teams")} icon={<PersonIcon size={15} />} count={teams.length}>
                Teams
              </TabItem>
              <TabItem active={tab === "profile"} onClick={() => setTab("profile")}>
                Profile
              </TabItem>
            </TabNav>

            {tab === "members" && (
              <MembersTab
                token={token}
                handle={org.handle}
                members={members}
                onChange={reloadOrg}
                fail={fail}
                toast={toast}
              />
            )}

            {tab === "teams" && (
              <TeamsTab
                token={token}
                handle={org.handle}
                teams={teams}
                members={members}
                repos={repos}
                onChange={reloadTeams}
                fail={fail}
                toast={toast}
              />
            )}

            {tab === "profile" && (
              <ProfileTab token={token} handle={org.handle} org={profile!.org} onSaved={reloadOrg} fail={fail} toast={toast} />
            )}
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}

type ToastFn = ReturnType<typeof useToast>["toast"];

// ─── Members ─────────────────────────────────────────────────────────────────

function MembersTab({
  token,
  handle,
  members,
  onChange,
  fail,
  toast,
}: {
  token: string;
  handle: string;
  members: OrgMember[];
  onChange: () => Promise<void>;
  fail: (e: unknown) => void;
  toast: ToastFn;
}) {
  const [newHandle, setNewHandle] = useState("");
  const [newRole, setNewRole] = useState<OrgRole>("MEMBER");
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await addOrgMember(token, handle, { handle: newHandle.trim(), role: newRole });
      setNewHandle("");
      setNewRole("MEMBER");
      await onChange();
      toast("Member added", { tone: "success" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(memberHandle: string, role: OrgRole) {
    try {
      await updateOrgMember(token, handle, memberHandle, role);
      await onChange();
    } catch (e) {
      fail(e);
    }
  }

  async function remove(memberHandle: string) {
    try {
      await removeOrgMember(token, handle, memberHandle);
      await onChange();
      toast("Member removed", { tone: "success" });
    } catch (e) {
      fail(e);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-md border border-fh-border bg-fh-surface p-4">
        <div className="min-w-[200px] flex-1">
          <Field label="Add a member" htmlFor="add-member-handle" hint="Their ForgeHub handle.">
            {(id) => (
              <TextInput id={id} value={newHandle} onChange={(e) => setNewHandle(e.target.value)} placeholder="handle" required />
            )}
          </Field>
        </div>
        <Field label="Role" htmlFor="add-member-role">
          {(id) => (
            <Select id={id} value={newRole} onChange={(e) => setNewRole(e.target.value as OrgRole)}>
              <option value="MEMBER">Member</option>
              <option value="OWNER">Owner</option>
            </Select>
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!newHandle.trim()}>
          Add
        </Button>
      </form>

      <ul className="divide-y divide-fh-border rounded-md border border-fh-border bg-fh-surface">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={m.displayName || m.handle} size={32} />
            <div className="min-w-0 flex-1">
              <Link to={`/${m.handle}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg no-underline">
                {m.handle}
              </Link>
              {m.displayName && <p className="truncate text-fh-sm text-fh-fg-muted">{m.displayName}</p>}
            </div>
            <div className="w-28">
              <Select
                sizing="sm"
                value={m.role}
                onChange={(e) => changeRole(m.handle, e.target.value as OrgRole)}
                aria-label={`Role for ${m.handle}`}
              >
                <option value="MEMBER">Member</option>
                <option value="OWNER">Owner</option>
              </Select>
            </div>
            <Button variant="danger" size="sm" onClick={() => remove(m.handle)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Teams ───────────────────────────────────────────────────────────────────

function TeamsTab({
  token,
  handle,
  teams,
  members,
  repos,
  onChange,
  fail,
  toast,
}: {
  token: string;
  handle: string;
  teams: Team[];
  members: OrgMember[];
  repos: Repo[];
  onChange: () => Promise<void>;
  fail: (e: unknown) => void;
  toast: ToastFn;
}) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await createTeam(token, handle, { name: newName.trim() });
      setNewName("");
      await onChange();
      toast("Team created", { tone: "success" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded-md border border-fh-border bg-fh-surface p-4">
        <div className="min-w-[200px] flex-1">
          <Field label="Create a team" htmlFor="new-team-name" hint="A URL slug is derived from the name.">
            {(id) => (
              <TextInput id={id} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Core Engineering" required />
            )}
          </Field>
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={!newName.trim()}>
          Create team
        </Button>
      </form>

      {teams.length === 0 ? (
        <p className="rounded-md border border-fh-border bg-fh-surface px-4 py-8 text-center text-fh-sm text-fh-fg-muted">
          No teams yet. Create one to grant a group of members access to repositories.
        </p>
      ) : (
        <div className="space-y-4">
          {teams.map((team) => (
            <TeamCard
              key={team.id}
              token={token}
              handle={handle}
              team={team}
              members={members}
              repos={repos}
              onChange={onChange}
              fail={fail}
              toast={toast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TeamCard({
  token,
  handle,
  team,
  members,
  repos,
  onChange,
  fail,
  toast,
}: {
  token: string;
  handle: string;
  team: Team;
  members: OrgMember[];
  repos: Repo[];
  onChange: () => Promise<void>;
  fail: (e: unknown) => void;
  toast: ToastFn;
}) {
  const [addHandle, setAddHandle] = useState("");
  const [grantRepo, setGrantRepo] = useState("");
  const [grantRole, setGrantRole] = useState<"READER" | "WRITER">("READER");

  const memberHandles = new Set(team.members.map((m) => m.handle));
  const addableMembers = members.filter((m) => !memberHandles.has(m.handle));
  const grantedRepoNames = new Set(team.repos.map((r) => r.name));
  const grantableRepos = repos.filter((r) => !grantedRepoNames.has(r.name));

  async function addMember() {
    if (!addHandle) return;
    try {
      await addTeamMember(token, handle, team.slug, addHandle);
      setAddHandle("");
      await onChange();
    } catch (e) {
      fail(e);
    }
  }

  async function removeMember(memberHandle: string) {
    try {
      await removeTeamMember(token, handle, team.slug, memberHandle);
      await onChange();
    } catch (e) {
      fail(e);
    }
  }

  async function grant() {
    if (!grantRepo) return;
    try {
      await grantTeamRepo(token, handle, team.slug, { repo: grantRepo, role: grantRole });
      setGrantRepo("");
      setGrantRole("READER");
      await onChange();
      toast("Access granted", { tone: "success" });
    } catch (e) {
      fail(e);
    }
  }

  async function revoke(repoName: string) {
    try {
      await revokeTeamRepo(token, handle, team.slug, repoName);
      await onChange();
    } catch (e) {
      fail(e);
    }
  }

  async function remove() {
    try {
      await deleteTeam(token, handle, team.slug);
      await onChange();
      toast("Team deleted", { tone: "success" });
    } catch (e) {
      fail(e);
    }
  }

  return (
    <section className="rounded-md border border-fh-border bg-fh-surface">
      <header className="flex items-center justify-between gap-2 border-b border-fh-border px-4 py-3">
        <div>
          <h3 className="font-semibold text-fh-fg">{team.name}</h3>
          <p className="text-fh-xs text-fh-fg-subtle">@{handle}/{team.slug}</p>
        </div>
        <Button variant="danger" size="sm" onClick={remove}>
          Delete team
        </Button>
      </header>

      <div className="grid gap-6 p-4 md:grid-cols-2">
        {/* Members */}
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-fh-sm font-semibold text-fh-fg">
            <PersonIcon size={14} /> Members ({team.members.length})
          </h4>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {team.members.length === 0 && <span className="text-fh-sm text-fh-fg-muted">No members yet.</span>}
            {team.members.map((m) => (
              <span key={m.id} className="inline-flex items-center gap-1 rounded-full border border-fh-border bg-fh-canvas py-0.5 pl-1 pr-2 text-fh-sm">
                <Avatar name={m.displayName || m.handle} size={18} />
                {m.handle}
                <button
                  type="button"
                  onClick={() => removeMember(m.handle)}
                  className="ml-0.5 cursor-pointer border-0 bg-transparent px-0.5 text-fh-fg-muted hover:text-fh-danger-fg"
                  aria-label={`Remove ${m.handle} from ${team.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Select sizing="sm" value={addHandle} onChange={(e) => setAddHandle(e.target.value)} aria-label="Add team member">
              <option value="">Add member…</option>
              {addableMembers.map((m) => (
                <option key={m.id} value={m.handle}>
                  {m.handle}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="default" onClick={addMember} disabled={!addHandle}>
              Add
            </Button>
          </div>
        </div>

        {/* Repo access */}
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-fh-sm font-semibold text-fh-fg">
            <RepoIcon size={14} /> Repository access ({team.repos.length})
          </h4>
          <ul className="mb-3 space-y-1">
            {team.repos.length === 0 && <li className="text-fh-sm text-fh-fg-muted">No repositories granted.</li>}
            {team.repos.map((r) => (
              <li key={r.repoId} className="flex items-center gap-2 text-fh-sm">
                <span className="font-medium text-fh-fg">{r.name}</span>
                <Badge tone={r.role === "WRITER" ? "accent" : "neutral"}>{r.role === "WRITER" ? "Write" : "Read"}</Badge>
                <button
                  type="button"
                  onClick={() => revoke(r.name)}
                  className="ml-auto cursor-pointer border-0 bg-transparent text-fh-xs text-fh-fg-muted hover:text-fh-danger-fg"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Select sizing="sm" value={grantRepo} onChange={(e) => setGrantRepo(e.target.value)} aria-label="Grant repository">
              <option value="">Add repository…</option>
              {grantableRepos.map((r) => (
                <option key={r.id} value={r.name}>
                  {r.name}
                </option>
              ))}
            </Select>
            <Select sizing="sm" value={grantRole} onChange={(e) => setGrantRole(e.target.value as "READER" | "WRITER")} aria-label="Grant role">
              <option value="READER">Read</option>
              <option value="WRITER">Write</option>
            </Select>
            <Button size="sm" variant="default" onClick={grant} disabled={!grantRepo}>
              Grant
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Profile ─────────────────────────────────────────────────────────────────

function ProfileTab({
  token,
  handle,
  org,
  onSaved,
  fail,
  toast,
}: {
  token: string;
  handle: string;
  org: OrgProfile["org"];
  onSaved: () => Promise<void>;
  fail: (e: unknown) => void;
  toast: ToastFn;
}) {
  const [displayName, setDisplayName] = useState(org.displayName);
  const [description, setDescription] = useState(org.description ?? "");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await updateOrg(token, handle, { displayName: displayName.trim(), description: description.trim() || null });
      await onSaved();
      toast("Organization updated", { tone: "success" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex max-w-[560px] flex-col gap-4 rounded-md border border-fh-border bg-fh-surface p-5">
      <Field label="Display name" htmlFor="org-display-name">
        {(id) => <TextInput id={id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />}
      </Field>
      <Field label="Description" htmlFor="org-description">
        {(id) => (
          <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        )}
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
