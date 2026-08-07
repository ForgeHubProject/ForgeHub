/**
 * The migration history must be able to build the schema the code expects.
 *
 * ## Why this exists
 *
 * It silently stopped being true. The history sat at
 * `20260707034027_add_personal_access_tokens` while `schema.prisma` gained 37 more
 * tables — SSHKey, DeployKey, Webhook, Milestone, Star, Watch, Reaction,
 * TimelineEvent, the CI tables, orgs, projects — none of which were ever written as
 * a migration. Every one of them arrived through `prisma db push`, which mutates a
 * database directly and records nothing.
 *
 * Nothing caught it, because nothing in the test suite or CI ever ran the
 * migrations. Tests build their fixtures with `db push` or against a client
 * generated straight from `schema.prisma`, so the whole suite was green while
 * `docker compose up` on a fresh volume produced a database missing most of the
 * application. The failure was invisible from inside the repo and total from
 * outside it.
 *
 * ## What is asserted
 *
 * Both directions of the same property, because they fail differently:
 *
 *  1. `migrations/` and `schema.prisma` describe the same database. Catches a model
 *     added to the schema with no accompanying migration — the drift above.
 *  2. Applying them for real with `migrate deploy` produces that database. Catches a
 *     migration that is individually well-formed but cannot execute in sequence —
 *     which is what #168's `ALTER TABLE "SSHKey"` was, ordered before anything
 *     created `SSHKey`. A `--from-migrations` diff alone does not always surface
 *     that; running them does.
 *
 * ## If this fails
 *
 * You changed `schema.prisma` without a migration. Generate one:
 *
 *     npx prisma migrate dev --name <what_you_changed>     # from apps/api
 *
 * Do not "fix" it by switching a deploy path to `db push`. That is how the history
 * got 37 tables behind, and `db push --accept-data-loss` drops whatever does not
 * match the schema — on a developer's laptop that is an inconvenience, on an
 * operator's instance it is their data.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/** `apps/api`, where the prisma schema and the workspace binary live. */
const API_DIR = fileURLToPath(new URL("../..", import.meta.url));
const PRISMA = join(API_DIR, "../../node_modules/.bin/prisma");

const SCHEMA = "./prisma/schema.prisma";
const MIGRATIONS = "./prisma/migrations";

/**
 * Run the prisma CLI, returning stdout/stderr and the exit code rather than
 * throwing — `migrate diff --exit-code` uses exit 2 to mean "there is a diff",
 * which is a result here, not an error.
 */
async function prisma(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(PRISMA, args, {
      cwd: API_DIR,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

describe("prisma migration history", () => {
  it("describes the same database as schema.prisma", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-drift-"));
    try {
      const r = await prisma([
        "migrate",
        "diff",
        "--from-migrations",
        MIGRATIONS,
        "--to-schema-datamodel",
        SCHEMA,
        "--shadow-database-url",
        `file:${join(dir, "shadow.db")}`,
        "--exit-code",
        "--script",
      ]);

      // 0 = no difference. 2 = the history and the schema disagree; the script on
      // stdout is exactly the migration that is missing. 1 = the CLI failed, which
      // on this path usually means a migration cannot apply at all.
      expect({ code: r.code, detail: r.code === 0 ? "" : `${r.out}\n${r.err}`.slice(0, 4000) }).toEqual({
        code: 0,
        detail: "",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("actually applies, in order, onto an empty database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-deploy-"));
    const url = `file:${join(dir, "fresh.db")}`;
    try {
      // The same command docker-entrypoint.sh runs at boot.
      const deploy = await prisma(["migrate", "deploy"], { DATABASE_URL: url });
      expect(`${deploy.code}: ${deploy.out}${deploy.err}`.slice(0, 4000)).toContain(
        "All migrations have been successfully applied",
      );

      // And the database it built is the one the Prisma client expects — a
      // migration can apply cleanly and still leave the schema wrong.
      const drift = await prisma([
        "migrate",
        "diff",
        "--from-url",
        url,
        "--to-schema-datamodel",
        SCHEMA,
        "--exit-code",
        "--script",
      ]);
      expect({ code: drift.code, detail: drift.code === 0 ? "" : `${drift.out}\n${drift.err}`.slice(0, 4000) }).toEqual(
        { code: 0, detail: "" },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
