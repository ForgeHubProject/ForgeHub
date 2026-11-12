import { useState } from "react";
import { API_BASE, httpsCloneUrl, sshCloneUrl } from "../../api";
import { useToast } from "../../ui";

/**
 * A repository with no commits yet, GitHub-style: its clone URL and the
 * commands that put the first commit in. Only for people who can push;
 * everyone else just reads that it's empty.
 */
export function QuickSetup({ handle, repoName, defaultBranch, sshPort, sshHost, canPush }: {
  handle: string;
  repoName: string;
  defaultBranch: string;
  sshPort?: number | null;
  sshHost?: string | null;
  canPush: boolean;
}) {
  const sshEnabled = typeof sshPort === "number" && sshPort > 0;
  const [protocol, setProtocol] = useState<"https" | "ssh">(sshEnabled ? "ssh" : "https");

  if (!canPush) {
    return (
      <div className="border border-fh-border rounded-md bg-fh-surface p-16 text-center">
        <p className="text-fh-xl font-semibold text-fh-fg">This repository is empty</p>
        <p className="text-fh-fg-muted text-fh-base mt-2">Nothing has been pushed to it yet.</p>
      </div>
    );
  }

  const url =
    protocol === "ssh" && sshEnabled
      ? sshCloneUrl({ handle, repoName, sshPort, sshHost, hostname: window.location.hostname })
      : httpsCloneUrl({ apiBase: API_BASE, origin: window.location.origin, handle, repoName });
  const branch = defaultBranch || "main";

  return (
    <div className="border border-fh-border rounded-md bg-fh-surface divide-y divide-fh-border">
      <section className="p-4">
        <h3 className="text-fh-base font-semibold text-fh-fg">Quick setup — if you've done this kind of thing before</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {sshEnabled && (
            <div className="inline-flex rounded-md border border-fh-border overflow-hidden text-fh-xs" role="tablist" aria-label="Clone protocol">
              {(["https", "ssh"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={protocol === p}
                  onClick={() => setProtocol(p)}
                  className={
                    "px-2.5 py-1 font-medium cursor-pointer " +
                    (protocol === p ? "bg-fh-surface-muted text-fh-fg" : "bg-fh-surface text-fh-fg-muted hover:text-fh-fg")
                  }
                >
                  {p === "https" ? "HTTPS" : "SSH"}
                </button>
              ))}
            </div>
          )}
          <CopyField text={url} label="Copy clone URL" />
        </div>
        <p className="mt-2 text-fh-xs text-fh-fg-subtle">
          {protocol === "ssh" && sshEnabled
            ? "Uses an SSH key added in Settings → SSH keys."
            : "Git asks for your ForgeHub username, and a personal access token (Settings → Personal access tokens) or your password."}
        </p>
      </section>
      <Snippet
        title="…or create a new repository on the command line"
        lines={[
          `echo "# ${repoName}" >> README.md`,
          "git init",
          "git add README.md",
          'git commit -m "first commit"',
          `git branch -M ${branch}`,
          `git remote add origin ${url}`,
          `git push -u origin ${branch}`,
        ]}
      />
      <Snippet
        title="…or push an existing repository from the command line"
        lines={[`git remote add origin ${url}`, `git branch -M ${branch}`, `git push -u origin ${branch}`]}
      />
    </div>
  );
}

function Snippet({ title, lines }: { title: string; lines: string[] }) {
  const text = lines.join("\n");
  return (
    <section className="p-4">
      <h3 className="text-fh-base font-semibold text-fh-fg">{title}</h3>
      <div className="mt-3 relative">
        <pre className="font-mono text-fh-xs text-fh-fg bg-fh-surface-inset border border-fh-border rounded-md p-3 pr-12 overflow-x-auto">
          {text}
        </pre>
        <div className="absolute top-2 right-2">
          <CopyButton text={text} label={`Copy: ${title.replace(/^…or /, "")}`} />
        </div>
      </div>
    </section>
  );
}

function CopyField({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex-1 min-w-[260px] flex items-center gap-1.5">
      <span className="flex-1 min-w-0 truncate font-mono text-fh-xs text-fh-fg-muted bg-fh-surface-inset border border-fh-border rounded-md px-2 py-1.5">
        {text}
      </span>
      <CopyButton text={text} label={label} />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(text).then(() => toast("Copied", { tone: "success" }))}
      aria-label={label}
      title={label}
      className="shrink-0 inline-flex items-center justify-center h-[30px] w-8 rounded-md border border-fh-border bg-fh-surface text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg cursor-pointer"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z" />
        <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z" />
      </svg>
    </button>
  );
}
