import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPull } from "../../../api";
import type { BranchInfo } from "../../../types";
import { Button, Field, Select, TextInput, Textarea } from "../../../ui";
import { ArrowLeftIcon, ArrowRightIcon, GitBranchIcon, GitPullRequestIcon } from "./prShared";

export function PullCreate({
  token,
  handle,
  repoName,
  branches,
  defaultBranch,
  currentRef,
}: {
  token: string;
  handle: string;
  repoName: string;
  branches: BranchInfo[];
  defaultBranch: string;
  currentRef: string;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const initialFrom =
    currentRef !== defaultBranch ? currentRef : branches.find((b) => !b.isDefault)?.name ?? currentRef;
  const [fromBranch, setFromBranch] = useState(initialFrom);
  const [toBranch, setToBranch] = useState(defaultBranch);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sameBranch = fromBranch === toBranch;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || sameBranch) return;
    setSubmitting(true);
    setError(null);
    try {
      const pr = await createPull(
        token,
        handle,
        repoName,
        title.trim(),
        fromBranch,
        toBranch,
        description.trim() || undefined,
      );
      navigate(`${base}/pulls/${pr.number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pull request");
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <Link
        to={`${base}/pulls`}
        className="inline-flex items-center gap-1.5 text-fh-sm text-fh-fg-muted hover:text-fh-accent-fg mb-4 no-underline"
      >
        <ArrowLeftIcon size={14} />
        Pull requests
      </Link>

      <h1 className="text-fh-2xl font-semibold text-fh-fg mb-1">New pull request</h1>
      <p className="text-fh-sm text-fh-fg-muted mb-5">
        Compare two branches and open a pull request to propose and review changes.
      </p>

      {/* Branch selectors */}
      <div className="rounded-md border border-fh-border bg-fh-surface p-4 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <Field label="Base branch" hint="Where changes will merge into" className="flex-1">
            {(id) => (
              <Select id={id} value={toBranch} onChange={(e) => setToBranch(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                    {b.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="hidden sm:flex items-center justify-center h-8 text-fh-fg-subtle">
            <ArrowLeftIcon size={16} />
          </div>
          <Field label="Compare branch" hint="The branch with your changes" className="flex-1">
            {(id) => (
              <Select id={id} value={fromBranch} onChange={(e) => setFromBranch(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="mt-3 flex items-center gap-2 text-fh-sm text-fh-fg-muted">
          <GitBranchIcon size={14} className="text-fh-fg-subtle shrink-0" />
          {sameBranch ? (
            <span className="text-fh-danger-fg">Base and compare branches must be different.</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 flex-wrap">
              <span className="font-mono text-fh-xs px-1.5 py-0.5 rounded bg-fh-surface-muted border border-fh-border">
                {fromBranch}
              </span>
              <ArrowRightIcon size={13} className="text-fh-fg-subtle" />
              <span className="font-mono text-fh-xs px-1.5 py-0.5 rounded bg-fh-surface-muted border border-fh-border">
                {toBranch}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Form */}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title" required>
          {(id) => (
            <TextInput
              id={id}
              placeholder="Pull request title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Description" hint="Optional. Markdown is supported.">
          {(id) => (
            <Textarea
              id={id}
              rows={6}
              placeholder="Describe your changes…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<GitPullRequestIcon size={15} />}
            loading={submitting}
            disabled={!title.trim() || sameBranch}
          >
            Create pull request
          </Button>
          <Link to={`${base}/pulls`} className="no-underline">
            <Button variant="default">Cancel</Button>
          </Link>
        </div>
      </form>
    </div>
  );
}
