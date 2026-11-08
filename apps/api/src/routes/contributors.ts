import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { getAuthorTallies } from "../contributors.js";
import { getInsights } from "../insights.js";

/** How many contributors one response lists; `total` still counts them all. */
const MAX_LISTED = 100;
/** How many contributors Insights charts. */
const MAX_LISTED_INSIGHTS = 25;

export type ContributorUser = { handle: string; displayName: string | null; avatarKey: string | null };
export type Contributor = { name: string; commits: number; user: ContributorUser | null };

/** Link commit emails to accounts: an email match, by someone who can push here (see below). */
async function linkAuthors(repo: Parameters<typeof canWrite>[0], emails: string[]): Promise<Map<string, ContributorUser>> {
  const accounts = emails.length
    ? await prisma.user.findMany({
        where: { email: { in: emails } },
        select: { id: true, email: true, handle: true, displayName: true, avatarKey: true },
      })
    : [];
  const linked = new Map<string, ContributorUser>();
  for (const a of accounts) {
    if (canWrite(repo, a.id)) linked.set(a.email.toLowerCase(), { handle: a.handle, displayName: a.displayName, avatarKey: a.avatarKey });
  }
  return linked;
}

export async function contributorsRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/insights?ref= — Insights (#256): weekly commits and
  // code frequency, the top contributors with their weeks, and the last year by
  // weekday. Authors link to accounts by the same rule as the contributors list.
  app.get("/repos/:handle/:name/insights", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    const { ref } = request.query as { ref?: string };
    const insights = repo.storageKey ? await getInsights(repo.storageKey, ref) : null;
    if (!insights) return { ref: ref ?? null, sha: null, weeks: [], authors: [], days: [], scanned: 0, truncated: false };
    const top = insights.authors.slice(0, MAX_LISTED_INSIGHTS);
    const linked = await linkAuthors(repo, top.map((a) => a.email));
    return {
      ...insights,
      authors: top.map(({ email, ...a }) => ({ ...a, user: linked.get(email) ?? null })),
    };
  });

  // GET /repos/:handle/:name/contributors?ref=  — commit authors at a ref (default
  // branch when omitted), most commits first (issue #209).
  //
  // An author links to a ForgeHub account only when the account's email matches
  // AND the account can push to this repository. ForgeHub does not verify email
  // addresses, so an email match alone would let anyone who registers with
  // someone else's address collect that person's commits on their profile;
  // people the owners already trust to push are the ones vouched for. Everyone
  // else is listed by name. Emails are used for matching only — none is sent.
  app.get("/repos/:handle/:name/contributors", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });

    const { ref } = request.query as { ref?: string };
    const result = repo.storageKey ? await getAuthorTallies(repo.storageKey, ref) : null;
    if (!result) return { ref: ref ?? null, sha: null, total: 0, contributors: [] };

    const listed = result.tallies.slice(0, MAX_LISTED);
    const linked = await linkAuthors(repo, listed.map((t) => t.email));

    const contributors: Contributor[] = listed.map((t) => ({
      name: t.name,
      commits: t.commits,
      user: linked.get(t.email) ?? null,
    }));
    return { ref: result.ref, sha: result.sha, total: result.tallies.length, contributors };
  });
}
