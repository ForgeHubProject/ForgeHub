import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Avatar, Button, Field, Select, Textarea, TextInput } from "../../../ui";
import { createIssue, listLabels, listRepoMembers, listRepoTemplates, RepoMember, updateIssue } from "../../../api";
import type { IssueTemplate, Label, User } from "../../../types";
import { canReplaceBody, resolveTemplateLabels } from "../templatesModel";
import { SidebarAssignee, SidebarLabels } from "./Sidebar";
import { ChevronLeftIcon } from "./icons";

export function NewIssueComposer({ token, handle, repoName, user }: {
  token: string; handle: string; repoName: string; user: User;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [selected, setSelected] = useState<Label[]>([]);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Repo-provided issue templates (issue #89) — absent for most repos.
  const [templates, setTemplates] = useState<IssueTemplate[]>([]);
  const [templatePath, setTemplatePath] = useState("");
  const [appliedBody, setAppliedBody] = useState<string | null>(null);

  useEffect(() => {
    listLabels(token, handle, repoName).then((d) => setAllLabels(d.labels)).catch(() => {});
    listRepoMembers(token, handle, repoName).then((d) => setMembers(d.members)).catch(() => {});
    // A repo without templates (or an unreadable one) just leaves the picker off.
    listRepoTemplates(token, handle, repoName).then((d) => setTemplates(d.issueTemplates)).catch(() => {});
  }, [token, handle, repoName]);

  /**
   * Apply a template: its body fills the description (unless the author has
   * already typed something of their own) and its front-matter labels pre-apply,
   * resolved against the repo's real labels so unknown names are ignored.
   */
  function chooseTemplate(path: string) {
    setTemplatePath(path);
    const template = templates.find((t) => t.path === path);
    if (!template) return;
    if (canReplaceBody(body, appliedBody)) {
      setBody(template.body);
      setAppliedBody(template.body);
    }
    const preset = resolveTemplateLabels(allLabels, template.labels);
    if (preset.length > 0) {
      setSelected((prev) => [...prev, ...preset.filter((l) => !prev.some((p) => p.id === l.id))]);
    }
  }

  function toggleLabel(label: Label) {
    setSelected((prev) =>
      prev.some((l) => l.id === label.id) ? prev.filter((l) => l.id !== label.id) : [...prev, label],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const issue = await createIssue(
        token, handle, repoName,
        title.trim(),
        body.trim() || undefined,
        selected.map((l) => l.id),
      );
      if (assignee) {
        const member = members.find((m) => m.handle === assignee);
        if (member) {
          try { await updateIssue(token, handle, repoName, issue.number, { assigneeId: member.id }); } catch { /* non-fatal */ }
        }
      }
      navigate(`${base}/issues/${issue.number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue");
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Link
        to={`${base}/issues`}
        className="inline-flex items-center gap-1 text-fh-sm text-fh-fg-muted hover:text-fh-accent-fg mb-3"
      >
        <ChevronLeftIcon size={14} />
        Issues
      </Link>

      <h1 className="text-fh-xl font-semibold text-fh-fg pb-4 mb-6 border-b border-fh-border">New issue</h1>

      <form onSubmit={submit} className="flex flex-col lg:flex-row gap-6">
        {/* Main form */}
        <div className="flex-1 min-w-0">
          <div className="flex gap-3">
            <Avatar name={user.displayName ?? user.handle} size={32} className="hidden sm:inline-flex mt-1" />
            <div className="flex-1 min-w-0 border border-fh-border rounded-md bg-fh-surface p-4 space-y-4">
              <Field label="Title" required>
                {(id) => (
                  <TextInput
                    id={id}
                    placeholder="Title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    autoFocus
                    required
                  />
                )}
              </Field>
              {templates.length > 0 && (
                <Field label="Template" hint="Start from one of this repository's issue templates.">
                  {(id) => (
                    <Select id={id} value={templatePath} onChange={(e) => chooseTemplate(e.target.value)}>
                      <option value="">No template</option>
                      {templates.map((t) => (
                        <option key={t.path} value={t.path}>
                          {t.name}{t.about ? ` — ${t.about}` : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label="Description" hint="Styling with Markdown is supported.">
                {(id) => (
                  <Textarea
                    id={id}
                    rows={10}
                    placeholder="Leave a description"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                )}
              </Field>
              {error && <p className="text-fh-sm text-fh-danger-fg bg-fh-danger-muted rounded-md px-3 py-2">{error}</p>}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-fh-border-muted">
                <Button variant="default" onClick={() => navigate(`${base}/issues`)}>Cancel</Button>
                <Button type="submit" variant="primary" loading={submitting} disabled={!title.trim()}>
                  Submit new issue
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="w-full lg:w-64 shrink-0">
          <SidebarLabels allLabels={allLabels} selected={selected} onToggle={toggleLabel} canEdit />
          <SidebarAssignee members={members} selectedHandle={assignee} onSelect={setAssignee} canEdit />
        </aside>
      </form>
    </div>
  );
}
