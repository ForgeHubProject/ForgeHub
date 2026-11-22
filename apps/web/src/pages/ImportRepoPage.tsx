import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRepo, getMyOrgs } from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { Organization, User } from "../types";
import { Button, Field, Select, TextInput, useToast } from "../ui";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

/** Sentinel namespace value for the caller's personal account. */
const PERSONAL = "@me";

/** The name a GitHub URL or "owner/name" ends in, offered as the new repository's name. */
export function repoNameFromUrl(url: string): string {
  const m = /[^/]\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * Import a public GitHub repository (#289): its branches, tags, default branch,
 * description and topics. The server checks the URL and runs the import in the
 * background; the new repository's page shows how it goes.
 */
export function ImportRepoPage({ token, user, onLogout }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  // The name follows the URL until the person types their own.
  const [name, setName] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [namespace, setNamespace] = useState(PERSONAL);
  const [withIssues, setWithIssues] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repoName = name ?? repoNameFromUrl(url);

  useEffect(() => {
    getMyOrgs(token)
      .then(({ orgs: o }) => setOrgs(o))
      .catch(() => setOrgs([]));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const owner = namespace === PERSONAL ? undefined : namespace;
      const repo = await createRepo(token, repoName.trim(), undefined, "public", owner, undefined, url.trim(), withIssues);
      toast("Import started", { tone: "success" });
      navigate(`/${repo.fullName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the import");
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto w-full max-w-[640px] flex-1 px-4 py-8">
        <h1 className="text-fh-2xl font-semibold text-fh-fg">Import a repository from GitHub</h1>
        <p className="mt-1 text-fh-base text-fh-fg-muted">
          Brings over every branch and tag, the default branch, the description and topics, and if you like its
          issues, pull requests, labels, milestones and releases.
        </p>
        <p className="mt-2 text-fh-sm text-fh-fg-muted">
          Moving a whole organization?{" "}
          <Link to="/new/import/org" className="text-fh-accent-fg hover:underline">Import an organization</Link>
        </p>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-5 rounded-md border border-fh-border bg-fh-surface p-6">
          <Field
            label="GitHub repository URL"
            required
            htmlFor="import-url"
            hint="A public repository of up to 1 GB, as https://github.com/owner/name or owner/name."
          >
            {(id) => (
              <TextInput
                id={id}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/octocat/Hello-World"
                autoFocus
                required
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>

          {orgs.length > 0 && (
            <Field label="Owner" htmlFor="import-namespace" hint="Where the imported repository lives.">
              {(id) => (
                <Select id={id} value={namespace} onChange={(e) => setNamespace(e.target.value)}>
                  <option value={PERSONAL}>{user.handle} (personal)</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.handle}>
                      {o.handle}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <Field
            label="Repository name"
            required
            htmlFor="import-name"
            hint="Lowercase letters, numbers, hyphens and dots only. It will be public, like the original."
          >
            {(id) => (
              <TextInput
                id={id}
                value={repoName}
                onChange={(e) => setName(e.target.value)}
                placeholder="hello-world"
                required
              />
            )}
          </Field>

          <label className="flex items-start gap-2 text-fh-sm text-fh-fg cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 accent-fh-accent-emphasis"
              checked={withIssues}
              onChange={(e) => setWithIssues(e.target.checked)}
            />
            <span>
              Also bring its issues, pull requests, labels, milestones and releases
              <span className="block text-fh-xs text-fh-fg-subtle">
                With their conversations and original numbers, releases with their files, after the code. Review
                comments on lines stay on GitHub for now.
              </span>
            </span>
          </label>

          {error && (
            <p role="alert" className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="default" type="button" onClick={() => navigate(-1)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={saving} disabled={!url.trim() || !repoName.trim()}>
              Begin import
            </Button>
          </div>
        </form>
      </div>
      <Footer />
    </div>
  );
}
