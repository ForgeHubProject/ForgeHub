#!/usr/bin/env node
/**
 * dev-seed.mjs — populate a RUNNING ForgeHub API with realistic demo data so the
 * UI can be exercised against real content (and screenshotted by dev-shot.mjs).
 *
 * It registers a demo user, mints a PAT, creates repositories, pushes real git
 * history over ForgeHub's smart-HTTP endpoint (README + source + several commits
 * + a feature branch), then adds labels, issues, a pull request, and a release.
 *
 * Usage:
 *   node scripts/dev-seed.mjs                       # API at http://localhost:3100
 *   API_URL=http://localhost:3001 node scripts/dev-seed.mjs
 *
 * The API must already be running with a migrated database. Endpoints and rules
 * (label color = 6 hex no '#', PRs need two pushed branches, tag releases need a
 * pushed commit, git push auth = Basic with the PAT as password) are per
 * apps/api/src/routes/*.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_URL = (process.env.API_URL || "http://localhost:3100").replace(/\/$/, "");
const DEMO = {
  email: "demo@forgehub.dev",
  password: "forgehub-demo",
  handle: "demo",
  displayName: "Demo User",
};

// ── tiny HTTP helper ─────────────────────────────────────────────────────────
async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body != null ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, body: json };
}

function log(step, msg) {
  console.log(`  ${step.padEnd(10)} ${msg}`);
}

// ── git push over smart-HTTP ─────────────────────────────────────────────────
function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
  }).toString();
}

/** Deterministic commit dates so history looks spread out, oldest first. */
function commitEnv(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    GIT_AUTHOR_DATE: d,
    GIT_COMMITTER_DATE: d,
    GIT_AUTHOR_NAME: DEMO.displayName,
    GIT_AUTHOR_EMAIL: DEMO.email,
    GIT_COMMITTER_NAME: DEMO.displayName,
    GIT_COMMITTER_EMAIL: DEMO.email,
  };
}

/**
 * Build a local repo from a spec and push its branches to the API.
 * spec = { name, commits: [{ message, daysAgo, branch?, files: {path: content} }] }
 * The first commit lands on `main`; a commit with `branch` switches to (creating)
 * that branch first.
 */
function pushRepo(spec, gitPassword) {
  const dir = mkdtempSync(join(tmpdir(), `fh-seed-${spec.name}-`));
  const branches = new Set(["main"]);
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", DEMO.displayName]);
    git(dir, ["config", "user.email", DEMO.email]);
    git(dir, ["config", "commit.gpgsign", "false"]);

    let current = "main";
    for (const c of spec.commits) {
      if (c.branch && c.branch !== current) {
        git(dir, ["checkout", "-q", "-b", c.branch]);
        current = c.branch;
        branches.add(c.branch);
      }
      for (const [rel, content] of Object.entries(c.files)) {
        const full = join(dir, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content);
      }
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", c.message], commitEnv(c.daysAgo));
    }

    const remote = `${API_URL.replace(/^http:\/\//, `http://x:${gitPassword}@`)}/git/${DEMO.handle}/${spec.name}.git`;
    for (const b of branches) {
      git(dir, ["push", "-q", remote, `${b}:${b}`]);
    }
    log("push", `${spec.name}: ${[...branches].join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── content ──────────────────────────────────────────────────────────────────
const README_AURORA = `# aurora-ui

A small, composable React component library with a cool cyan identity and
first-class dark mode.

## Install

\`\`\`bash
npm install aurora-ui
\`\`\`

## Usage

\`\`\`tsx
import { Button } from "aurora-ui";

export function App() {
  return <Button variant="primary">Get started</Button>;
}
\`\`\`

## Features

- Typed, tree-shakeable primitives
- Light and dark themes via CSS variables
- WCAG-AA verified color tokens
`;

const repos = [
  {
    name: "aurora-ui",
    description: "A composable React component library with a cyan identity and dark mode.",
    visibility: "public",
    commits: [
      {
        message: "Initial commit",
        daysAgo: 21,
        files: {
          "README.md": README_AURORA,
          "LICENSE": "MIT License\n\nCopyright (c) 2026 Demo User\n",
          "package.json": JSON.stringify(
            { name: "aurora-ui", version: "0.1.0", type: "module", license: "MIT" },
            null,
            2,
          ) + "\n",
        },
      },
      {
        message: "Add Button component and barrel export",
        daysAgo: 16,
        files: {
          "src/Button.tsx":
            'import type { ButtonHTMLAttributes } from "react";\n\n' +
            "type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: \"primary\" | \"default\" };\n\n" +
            "export function Button({ variant = \"default\", ...rest }: Props) {\n" +
            "  return <button data-variant={variant} {...rest} />;\n}\n",
          "src/index.ts": 'export { Button } from "./Button";\n',
        },
      },
      {
        message: "Document usage and features in the README",
        daysAgo: 9,
        files: { "README.md": README_AURORA + "\n## Contributing\n\nPRs welcome.\n" },
      },
      {
        message: "Add dark-mode theme tokens",
        daysAgo: 4,
        branch: "feature/dark-mode",
        files: {
          "src/theme.ts":
            "export const tokens = {\n" +
            "  light: { fg: \"#111820\", bg: \"#ffffff\", accent: \"#0b7fab\" },\n" +
            "  dark: { fg: \"#e6edf3\", bg: \"#11161d\", accent: \"#39c0e8\" },\n} as const;\n",
        },
      },
    ],
  },
  {
    name: "forge-cli",
    description: "Command-line client for talking to a ForgeHub server.",
    visibility: "public",
    commits: [
      {
        message: "Initial commit",
        daysAgo: 30,
        files: {
          "README.md": "# forge-cli\n\nA tiny CLI for ForgeHub.\n\n```bash\nforge clone demo/aurora-ui\n```\n",
          "package.json": JSON.stringify({ name: "forge-cli", version: "0.0.1", bin: { forge: "./cli.mjs" } }, null, 2) + "\n",
        },
      },
      {
        message: "Implement the clone subcommand",
        daysAgo: 12,
        files: {
          "cli.mjs": "#!/usr/bin/env node\nconst [cmd, arg] = process.argv.slice(2);\nif (cmd === \"clone\") console.log(`Cloning ${arg}…`);\n",
        },
      },
    ],
  },
  {
    name: "design-notes",
    description: "Working notes on the ForgeHub visual language.",
    visibility: "public",
    commits: [
      {
        message: "Start design notes",
        daysAgo: 6,
        files: { "README.md": "# design-notes\n\n- Cool, cyan-leaning accent.\n- Neutrals carry a faint blue cast.\n- 6px radius, hairline borders, overlay-only shadows.\n" },
      },
    ],
  },
];

const labels = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "enhancement", color: "0b7fab", description: "New feature or request" },
  { name: "documentation", color: "0b6f96", description: "Docs improvements" },
  { name: "good first issue", color: "7a44d6", description: "Good for newcomers" },
  { name: "help wanted", color: "137a4b", description: "Extra attention is needed" },
];

const issues = [
  { title: "Focus ring is invisible on Button in Safari", body: "The `:focus-visible` outline doesn't render on WebKit. Needs a fallback.", labels: ["bug"] },
  { title: "TabNav counter should truncate large counts", body: "Counts over 999 overflow the pill. Show `999+`.", labels: ["enhancement", "good first issue"] },
  { title: "Document the theming tokens", body: "Add a table of every CSS variable and its light/dark value.", labels: ["documentation", "help wanted"] },
  { title: "Dark mode flashes light on first paint", body: "There's a brief flash of the light theme before hydration.", labels: ["bug"] },
  { title: "Set up continuous integration", body: "Run typecheck + tests on every push.", labels: ["enhancement"], close: true },
];

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nForgeHub dev seed → ${API_URL}\n`);

  // 1) Register (or log in) the demo user.
  let token;
  const reg = await api("/auth/register", { method: "POST", body: DEMO });
  if (reg.ok) {
    token = reg.body.token;
    log("user", `registered @${DEMO.handle}`);
  } else if (reg.status === 409) {
    const login = await api("/auth/login", { method: "POST", body: { email: DEMO.email, password: DEMO.password } });
    if (!login.ok) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
    token = login.body.token;
    log("user", `logged in @${DEMO.handle} (already existed)`);
  } else {
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }

  // 2) Mint a PAT to use as the git password (fall back to the JWT).
  let gitPassword = token;
  const pat = await api("/auth/tokens", { method: "POST", token, body: { name: "dev-seed" } });
  if (pat.ok && pat.body.token) {
    gitPassword = pat.body.token;
    log("token", `PAT ${pat.body.prefix}…`);
  } else {
    log("token", "PAT creation skipped; using JWT for git");
  }

  // 3) Create repos + push git history.
  for (const repo of repos) {
    const created = await api("/repos", {
      method: "POST",
      token,
      body: { name: repo.name, description: repo.description, visibility: repo.visibility },
    });
    if (created.ok) log("repo", `created ${repo.name} (${repo.visibility})`);
    else if (created.status === 409) log("repo", `${repo.name} already exists — reusing`);
    else throw new Error(`create repo ${repo.name} failed: ${created.status} ${JSON.stringify(created.body)}`);

    pushRepo(repo, gitPassword);
  }

  // 4) Labels / issues / PR / release on the flagship repo.
  const flagship = "aurora-ui";
  const labelIds = {};
  for (const l of labels) {
    const r = await api(`/repos/${DEMO.handle}/${flagship}/labels`, { method: "POST", token, body: l });
    if (r.ok) labelIds[l.name] = r.body.id;
  }
  log("labels", `${Object.keys(labelIds).length} labels`);

  let issueCount = 0;
  for (const iss of issues) {
    const r = await api(`/repos/${DEMO.handle}/${flagship}/issues`, { method: "POST", token, body: { title: iss.title, body: iss.body } });
    if (!r.ok) continue;
    issueCount++;
    for (const name of iss.labels ?? []) {
      if (labelIds[name]) {
        await api(`/repos/${DEMO.handle}/${flagship}/issues/${r.body.number}/labels`, { method: "POST", token, body: { labelId: labelIds[name] } });
      }
    }
    if (iss.close) {
      await api(`/repos/${DEMO.handle}/${flagship}/issues/${r.body.number}`, { method: "PATCH", token, body: { state: "closed" } });
    }
  }
  log("issues", `${issueCount} issues`);

  // A comment for richness.
  const firstIssue = await api(`/repos/${DEMO.handle}/${flagship}/issues?state=open`, { token });
  if (firstIssue.ok && firstIssue.body.issues?.length) {
    const n = firstIssue.body.issues[firstIssue.body.issues.length - 1].number;
    await api(`/repos/${DEMO.handle}/${flagship}/issues/${n}/comments`, { method: "POST", token, body: { body: "I can reproduce this on WebKit 17. Looks like the outline is clipped by `overflow: hidden`." } });
  }

  // Pull request from the feature branch.
  const pr = await api(`/repos/${DEMO.handle}/${flagship}/pulls`, {
    method: "POST",
    token,
    body: {
      title: "Add dark mode support",
      fromBranch: "feature/dark-mode",
      description: "Introduces the light/dark theme tokens and wires them through the Button.",
    },
  });
  if (pr.ok) log("pr", `#${pr.body.number} ${pr.body.fromBranch} → ${pr.body.toBranch}`);
  else log("pr", `skipped (${pr.status})`);

  // Release cut from main.
  const rel = await api(`/repos/${DEMO.handle}/${flagship}/releases`, {
    method: "POST",
    token,
    body: { tagName: "v1.0.0", name: "v1.0.0 — First stable release", body: "Initial public release of aurora-ui.", targetCommitish: "main" },
  });
  if (rel.ok) log("release", rel.body.tagName);
  else log("release", `skipped (${rel.status})`);

  console.log(`\nDone. Sign in with:  ${DEMO.email}  /  ${DEMO.password}\n`);
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message);
  process.exit(1);
});
