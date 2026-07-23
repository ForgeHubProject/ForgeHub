import { z } from "zod";

/** GitHub-style username: alphanumeric + hyphen, no leading/trailing hyphen, 1–39 chars. */
export const handleSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/);

/** Repo slug: same rules, typical GitHub repo name length. */
export const repoNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/);

export const registerBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  handle: handleSchema,
  displayName: z.string().min(1).max(120).optional(),
});

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

/** v0 PAT scope set (issue #87). See src/scopes.ts for the hierarchy + defaults. */
export const patScopeSchema = z.enum(["repo:read", "repo:write", "admin"]);

export const createTokenBodySchema = z.object({
  name: z.string().min(1).max(120),
  expiresInDays: z.number().int().positive().max(3650).optional(),
  /** Optional subset; when omitted the token is minted with the full scope set. */
  scopes: z.array(patScopeSchema).optional(),
});

export const repoVisibilitySchema = z.enum(["public", "private"]);
export const collaboratorRoleSchema = z.enum(["reader", "writer"]);

export const createRepoBodySchema = z.object({
  name: repoNameSchema,
  description: z.string().max(2000).optional(),
  /** Defaults to `private` if omitted. */
  visibility: repoVisibilitySchema.optional().default("private"),
  /**
   * Target owning namespace (issue #114). Omitted / the caller's own handle ⇒ a
   * personal repo; an org handle the caller is a member of ⇒ a repo owned by that
   * org. Validated against the shared handle space in the route.
   */
  owner: handleSchema.optional(),
});

export const updateRepoBodySchema = z.object({
  description: z.string().max(2000).nullable().optional(),
  visibility: repoVisibilitySchema.optional(),
});

export const renameRepoBodySchema = z.object({
  name: repoNameSchema,
});

export const addCollaboratorBodySchema = z.object({
  handle: handleSchema,
  role: collaboratorRoleSchema.optional().default("reader"),
});

/**
 * A single repo topic: GitHub-style lowercase-kebab (letters/digits/hyphens, no
 * leading/trailing hyphen, no doubled hyphens), 1–35 chars. Validated on the way
 * in so the stored set stays clean and click-to-search links are predictable.
 */
export const topicSchema = z
  .string()
  .min(1)
  .max(35)
  .regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,34}$/, "Topics must be lowercase letters, digits, and single hyphens");

/** PUT /repos/:handle/:name/topics — the full replacement set (max 20, deduped by the route). */
export const updateTopicsBodySchema = z.object({
  topics: z.array(topicSchema).max(20),
});

// ─── Webhooks (issue #87) ──────────────────────────────────────────────────────

/** Subscribable outbound-webhook event names. `ping` is server-internal only. */
export const WEBHOOK_EVENTS = ["push", "issues", "issue_comment", "pull_request", "release"] as const;
export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);

export const createWebhookBodySchema = z.object({
  url: z.string().url().max(2000),
  secret: z.string().min(1).max(500),
  /** Subscribed events; when omitted the hook receives all ("*"). */
  events: z.array(webhookEventSchema).min(1).optional(),
  active: z.boolean().optional(),
});

export const updateWebhookBodySchema = z.object({
  url: z.string().url().max(2000).optional(),
  secret: z.string().min(1).max(500).optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
  active: z.boolean().optional(),
});

// ─── SSH keys + deploy keys (issue #116) ──────────────────────────────────────

/** POST /user/keys — a user's named SSH public key. */
export const createSSHKeyBodySchema = z.object({
  title: z.string().min(1).max(120),
  /** Raw OpenSSH public-key line ("type base64 [comment]"). Parsed + fingerprinted server-side. */
  publicKey: z.string().min(1).max(16384),
});

/** POST /repos/:handle/:name/keys — a repo deploy key (read-only unless granted write). */
export const createDeployKeyBodySchema = z.object({
  title: z.string().min(1).max(120),
  publicKey: z.string().min(1).max(16384),
  /** Defaults to read-only (clone/pull only) when omitted. */
  readOnly: z.boolean().optional(),
});

// ─── Organizations & teams (issue #114) ──────────────────────────────────────

/** Org role in the membership API. */
export const orgRoleSchema = z.enum(["OWNER", "MEMBER"]);
/** Team → repo grant role. */
export const teamAccessRoleSchema = z.enum(["READER", "WRITER"]);

/** POST /orgs — create an org. `handle` shares the user handle space. */
export const createOrgBodySchema = z.object({
  handle: handleSchema,
  displayName: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
});

/** PATCH /orgs/:handle — org profile settings (OWNER only). */
export const updateOrgBodySchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});

/** POST /orgs/:handle/members — add a member by handle at a role. */
export const addOrgMemberBodySchema = z.object({
  handle: handleSchema,
  role: orgRoleSchema.optional().default("MEMBER"),
});

/** PATCH /orgs/:handle/members/:memberHandle — change a member's role. */
export const updateOrgMemberBodySchema = z.object({
  role: orgRoleSchema,
});

/** Team slug: same rules as a handle (URL-safe within its org). */
export const teamSlugSchema = handleSchema;

/** POST /orgs/:handle/teams — create a team. `slug` defaults from `name`. */
export const createTeamBodySchema = z.object({
  name: z.string().min(1).max(120),
  slug: teamSlugSchema.optional(),
});

/** PATCH /orgs/:handle/teams/:slug — rename a team. */
export const updateTeamBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: teamSlugSchema.optional(),
});

/** POST /orgs/:handle/teams/:slug/members — add a user to a team. */
export const addTeamMemberBodySchema = z.object({
  handle: handleSchema,
});

/** POST /orgs/:handle/teams/:slug/repos — grant a team access to an org repo. */
export const grantTeamRepoBodySchema = z.object({
  repo: repoNameSchema,
  role: teamAccessRoleSchema.optional().default("READER"),
});
