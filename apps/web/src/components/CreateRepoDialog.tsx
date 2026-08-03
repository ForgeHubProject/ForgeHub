import { useEffect, useState } from "react";
import { createRepo } from "../api";
import type { Organization, Repo } from "../types";
import { Button, Dialog, Field, RadioCard, RadioGroup, Select, TextInput, Textarea, useToast } from "../ui";
import { LockIcon, RepoIcon } from "../pages/listShared";

const CREATE_FORM_ID = "create-repo-form";

/** Sentinel namespace value for the caller's personal account. */
const PERSONAL = "@me";

type Props = {
  open: boolean;
  token: string;
  /** The caller's personal handle (the default namespace). */
  personalHandle: string;
  /** Orgs the caller may create repos in — shown in the namespace picker. */
  orgs: Organization[];
  /**
   * When set, the namespace is fixed to this org handle and the picker is hidden
   * (used from an org profile, where the target is unambiguous).
   */
  lockedNamespace?: string;
  onClose: () => void;
  onCreated: (repo: Repo) => void;
};

/**
 * Shared "create a repository" dialog (issue #114). Adds a namespace picker so a
 * repo can be created under the caller's account OR any org they belong to. The
 * dashboard uses the free picker; the org profile locks it to that org.
 */
export function CreateRepoDialog({ open, token, personalHandle, orgs, lockedNamespace, onClose, onCreated }: Props) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [namespace, setNamespace] = useState<string>(lockedNamespace ?? PERSONAL);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setVisibility("private");
      setNamespace(lockedNamespace ?? PERSONAL);
      setError(null);
    }
  }, [open, lockedNamespace]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const owner = namespace === PERSONAL ? undefined : namespace;
      const repo = await createRepo(token, name, description || undefined, visibility, owner);
      toast("Repository created", { tone: "success" });
      onCreated(repo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  const showPicker = !lockedNamespace && orgs.length > 0;

  return (
    <Dialog
      open={open}
      onClose={creating ? () => {} : onClose}
      title="Create a new repository"
      description="A repository contains all your project's files and their revision history."
      footer={
        <>
          <Button variant="default" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button type="submit" form={CREATE_FORM_ID} variant="primary" loading={creating} disabled={!name.trim()}>
            Create repository
          </Button>
        </>
      }
    >
      <form id={CREATE_FORM_ID} onSubmit={submit} className="flex flex-col gap-4">
        {showPicker ? (
          <Field label="Owner" htmlFor="repo-namespace" hint="Where this repository lives.">
            {(id) => (
              <Select id={id} value={namespace} onChange={(e) => setNamespace(e.target.value)}>
                <option value={PERSONAL}>{personalHandle} (personal)</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.handle}>
                    {o.handle}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : lockedNamespace ? (
          <p className="text-fh-sm text-fh-fg-muted">
            Creating in <span className="font-semibold text-fh-fg">{lockedNamespace}</span>
          </p>
        ) : null}

        <Field
          label="Repository name"
          required
          htmlFor="repo-name"
          hint="Lowercase letters, numbers, hyphens and dots only."
        >
          {(id) => (
            <TextInput
              id={id}
              placeholder="my-project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          )}
        </Field>

        <Field label="Description" htmlFor="repo-desc">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              placeholder="Short description of your project (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>

        <RadioGroup
          name="visibility"
          legend="Visibility"
          value={visibility}
          onChange={(v) => setVisibility(v as "public" | "private")}
        >
          <RadioCard
            value="private"
            title="Private"
            icon={<LockIcon size={14} />}
            description="Only owners and collaborators can see this repository."
          />
          <RadioCard
            value="public"
            title="Public"
            icon={<RepoIcon size={14} />}
            description="Anyone can see this repository."
          />
        </RadioGroup>

        {error && (
          <p className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>
        )}
      </form>
    </Dialog>
  );
}
