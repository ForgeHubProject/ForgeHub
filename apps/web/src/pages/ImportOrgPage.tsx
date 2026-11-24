import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, getMyOrgs, importGithubOrg, lookupGithubOrg, type GithubOrg, type OrgImportTarget } from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { formatBytes } from "../lib/fileFacts";
import { defaultPicks, githubOrgLogin, nameHere } from "../lib/orgImport";
import type { Organization, User } from "../types";
import { Badge, Button, Field, RadioCard, RadioGroup, Select, TextInput, useToast } from "../ui";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

/**
 * Import a GitHub organization (#308): find it, pick which of its public
 * repositories to bring and what each is called here, then into a new
 * organization or one you own. They import one after another.
 */
export function ImportOrgPage({ token, user, onLogout }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [org, setOrg] = useState<GithubOrg | null>(null);
  const [owned, setOwned] = useState<Organization[]>([]);

  useEffect(() => {
    getMyOrgs(token)
      .then(({ orgs }) => setOwned(orgs.filter((o) => o.viewerRole === "OWNER")))
      .catch(() => setOwned([]));
  }, [token]);

  async function lookUp(e: React.FormEvent) {
    e.preventDefault();
    const login = githubOrgLogin(input);
    if (!login) {
      setLookupError("Enter a GitHub organization as https://github.com/name or name");
      return;
    }
    setLooking(true);
    setLookupError(null);
    try {
      setOrg(await lookupGithubOrg(token, login));
    } catch (err) {
      setOrg(null);
      setLookupError(err instanceof Error ? err.message : "Could not find that organization");
    } finally {
      setLooking(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto w-full max-w-[880px] flex-1 px-4 py-8">
        <h1 className="text-fh-2xl font-semibold text-fh-fg">Import an organization from GitHub</h1>
        <p className="mt-1 text-fh-base text-fh-fg-muted">
          Brings an organization&apos;s public repositories over, one after another, each the way{" "}
          <Link to="/new/import" className="text-fh-accent-fg hover:underline">importing a repository</Link> does.
        </p>

        <form onSubmit={lookUp} className="mt-6 flex flex-col gap-3 rounded-md border border-fh-border bg-fh-surface p-6">
          <Field
            label="GitHub organization"
            required
            htmlFor="import-org"
            error={lookupError ?? undefined}
            hint="Its public repositories are listed for you to pick from."
          >
            {(id) => (
              <div className="flex flex-col gap-2 sm:flex-row">
                <TextInput
                  id={id}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="https://github.com/octo-org"
                  autoFocus
                  required
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1"
                />
                <Button type="submit" variant="default" loading={looking} disabled={!input.trim()}>
                  Find repositories
                </Button>
              </div>
            )}
          </Field>
        </form>

        {org && (
          <OrgImportForm
            key={org.login}
            token={token}
            org={org}
            owned={owned}
            onDone={(handle) => {
              toast("Import started", { tone: "success" });
              navigate(`/orgs/${handle}/imports`);
            }}
          />
        )}
      </div>
      <Footer />
    </div>
  );
}

export function OrgImportForm({ token, org, owned, onDone }: {
  token: string;
  org: GithubOrg;
  owned: Organization[];
  onDone: (handle: string) => void;
}) {
  const [target, setTarget] = useState<"new" | "existing">("new");
  const [handle, setHandle] = useState(org.login.toLowerCase());
  const [displayName, setDisplayName] = useState(org.displayName ?? org.login);
  const [existing, setExisting] = useState(owned[0]?.handle ?? "");
  const [picked, setPicked] = useState(() => defaultPicks(org.repos, org.maxSizeKb));
  const [names, setNames] = useState<Record<string, string>>({});
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [withIssues, setWithIssues] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);

  useEffect(() => {
    if (!existing && owned[0]) setExisting(owned[0].handle);
  }, [owned, existing]);

  const importable = org.repos.filter((r) => r.sizeKb <= org.maxSizeKb);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? org.repos.filter((r) => r.name.toLowerCase().includes(q)) : org.repos;
  }, [org.repos, filter]);
  const chosen = org.repos.filter((r) => picked.has(r.name));
  const totalKb = chosen.reduce((sum, r) => sum + r.sizeKb, 0);
  const nameOf = (githubName: string) => names[githubName] ?? nameHere(githubName);

  function toggle(name: string, on: boolean) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setHandleError(null);
    setTaken(new Set());
    const into: OrgImportTarget = target === "new"
      ? {
          create: true,
          handle: handle.trim(),
          displayName: displayName.trim() || undefined,
          // GitHub's profile comes along: description, website, location and picture.
          description: org.description ?? undefined,
          website: org.website ?? undefined,
          location: org.location ?? undefined,
          avatarUrl: org.avatarUrl ?? undefined,
        }
      : { create: false, handle: existing };
    try {
      const res = await importGithubOrg(token, org.login, {
        into,
        repos: chosen.map((r) => ({ name: r.name, as: nameOf(r.name).trim() })),
        importIssues: withIssues,
      });
      onDone(res.org);
    } catch (err) {
      if (err instanceof ApiError && err.taken?.length) setTaken(new Set(err.taken));
      const message = err instanceof Error ? err.message : "Could not start the import";
      if (err instanceof ApiError && err.status === 409 && target === "new" && !err.taken) setHandleError(message);
      else setError(message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-6 rounded-md border border-fh-border bg-fh-surface p-6">
      <div>
        <p className="text-fh-lg font-semibold text-fh-fg">{org.displayName ?? org.login}</p>
        <a href={`https://github.com/${org.login}`} target="_blank" rel="noreferrer" className="text-fh-sm text-fh-accent-fg hover:underline">
          github.com/{org.login}
        </a>
        {org.description && <p className="mt-1 text-fh-sm text-fh-fg-muted">{org.description}</p>}
      </div>

      <RadioGroup name="import-into" value={target} onChange={(v) => setTarget(v as "new" | "existing")} legend="Into">
        <RadioCard value="new" title="A new organization" description="Its name, display name and description come from GitHub. You can change them later." />
        <RadioCard
          value="existing"
          title="An organization you own"
          description={owned.length ? "The repositories join the ones already there." : "You don't own an organization yet."}
          disabled={!owned.length}
        />
      </RadioGroup>

      {target === "new" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Organization name" required htmlFor="import-org-handle" error={handleError ?? undefined} hint="Letters, numbers and hyphens.">
            {(id) => <TextInput id={id} value={handle} onChange={(e) => setHandle(e.target.value)} required autoComplete="off" spellCheck={false} />}
          </Field>
          <Field label="Display name" htmlFor="import-org-display">
            {(id) => <TextInput id={id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
          </Field>
        </div>
      ) : (
        <Field label="Organization" htmlFor="import-org-existing">
          {(id) => (
            <Select id={id} value={existing} onChange={(e) => setExisting(e.target.value)}>
              {owned.map((o) => (
                <option key={o.id} value={o.handle}>{o.handle}</option>
              ))}
            </Select>
          )}
        </Field>
      )}

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-fh-sm font-semibold text-fh-fg">Repositories</legend>
        {org.repos.length === 0 ? (
          <p className="text-fh-sm text-fh-fg-muted">github.com/{org.login} has no public repositories.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="flex items-center gap-2 text-fh-sm text-fh-fg">
                <input
                  type="checkbox"
                  className="accent-fh-accent-emphasis"
                  checked={chosen.length === importable.length && importable.length > 0}
                  onChange={(e) => setPicked(e.target.checked ? new Set(importable.map((r) => r.name)) : new Set())}
                />
                {chosen.length} of {org.repos.length} picked
                {chosen.length > 0 && <span className="text-fh-fg-muted">· {formatBytes(totalKb * 1024)}</span>}
              </label>
              {org.repos.length > 10 && (
                <TextInput
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Find a repository…"
                  aria-label="Find a repository"
                  className="sm:ml-auto sm:w-64"
                />
              )}
            </div>
            <ul className="divide-y divide-fh-border rounded-md border border-fh-border">
              {shown.map((r) => {
                const tooBig = r.sizeKb > org.maxSizeKb;
                const clash = taken.has(nameOf(r.name).trim().toLowerCase());
                return (
                  <li key={r.name} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
                    <label className={`flex min-w-0 flex-1 items-start gap-2 ${tooBig ? "opacity-60" : "cursor-pointer"}`}>
                      <input
                        type="checkbox"
                        className="mt-1 accent-fh-accent-emphasis"
                        checked={picked.has(r.name)}
                        disabled={tooBig}
                        onChange={(e) => toggle(r.name, e.target.checked)}
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-fh-sm font-semibold text-fh-fg">{r.name}</span>
                          {r.fork && <Badge tone="neutral" variant="outline">Fork</Badge>}
                          {r.archived && (
                            <span title="Archived on GitHub: it comes over archived, read-only until its owner unarchives it.">
                              <Badge tone="warning" variant="outline">Archived</Badge>
                            </span>
                          )}
                          <span className="text-fh-xs text-fh-fg-muted">{tooBig ? "Over 1 GB, can't be imported" : formatBytes(r.sizeKb * 1024)}</span>
                        </span>
                        {r.description && <span className="block truncate text-fh-xs text-fh-fg-muted">{r.description}</span>}
                      </span>
                    </label>
                    {picked.has(r.name) && (
                      <div className="flex flex-col sm:w-56">
                        <TextInput
                          value={nameOf(r.name)}
                          onChange={(e) => setNames((cur) => ({ ...cur, [r.name]: e.target.value }))}
                          aria-label={`Name for ${r.name} here`}
                          aria-invalid={clash || undefined}
                          className={clash ? "border-fh-danger-emphasis" : undefined}
                          spellCheck={false}
                        />
                        {clash && <span className="text-fh-xs text-fh-danger-fg">Taken. Pick another name.</span>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {org.truncated && (
              <p className="text-fh-xs text-fh-fg-muted">Only the first 1,000 repositories are listed.</p>
            )}
          </>
        )}
      </fieldset>

      <label className="flex items-start gap-2 text-fh-sm text-fh-fg cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 accent-fh-accent-emphasis"
          checked={withIssues}
          onChange={(e) => setWithIssues(e.target.checked)}
        />
        <span>
          Also bring their issues, pull requests, labels, milestones and releases
          <span className="block text-fh-xs text-fh-fg-subtle">
            With their conversations and original numbers, releases with their files, after the code.
          </span>
        </span>
      </label>

      {error && (
        <p role="alert" className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="primary"
          type="submit"
          loading={saving}
          disabled={chosen.length === 0 || (target === "new" ? !handle.trim() : !existing)}
        >
          Import {chosen.length} {chosen.length === 1 ? "repository" : "repositories"}
        </Button>
      </div>
    </form>
  );
}
