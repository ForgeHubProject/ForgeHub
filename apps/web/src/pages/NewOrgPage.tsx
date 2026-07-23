import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createOrg } from "../api";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import type { User } from "../types";
import { Button, Field, TextInput, Textarea, useToast } from "../ui";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

/**
 * Create-organization flow (issue #114). An org is a shared owning namespace in
 * the same handle space as users, so the handle field mirrors the account-handle
 * rules; the creator becomes the org's first OWNER.
 */
export function NewOrgPage({ token, user, onLogout }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const org = await createOrg(token, {
        handle: handle.trim(),
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
      });
      toast("Organization created", { tone: "success" });
      navigate(`/${org.handle}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto w-full max-w-[640px] flex-1 px-4 py-8">
        <h1 className="text-fh-2xl font-semibold text-fh-fg">Create an organization</h1>
        <p className="mt-1 text-fh-base text-fh-fg-muted">
          Organizations let a group own repositories under a shared name and manage access with teams.
        </p>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-5 rounded-md border border-fh-border bg-fh-surface p-6">
          <Field
            label="Organization handle"
            required
            htmlFor="org-handle"
            hint="Unique across users and organizations. Letters, numbers, and single hyphens."
          >
            {(id) => (
              <TextInput
                id={id}
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="acme"
                autoFocus
                required
              />
            )}
          </Field>

          <Field label="Display name" htmlFor="org-name" hint="Shown on the organization profile. Defaults to the handle.">
            {(id) => (
              <TextInput
                id={id}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Acme, Inc."
                maxLength={120}
              />
            )}
          </Field>

          <Field label="Description" htmlFor="org-desc">
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this organization do? (optional)"
                maxLength={2000}
              />
            )}
          </Field>

          {error && (
            <p className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="default" type="button" onClick={() => navigate(-1)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={saving} disabled={!handle.trim()}>
              Create organization
            </Button>
          </div>
        </form>
      </div>
      <Footer />
    </div>
  );
}
