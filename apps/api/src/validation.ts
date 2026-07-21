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

export const createTokenBodySchema = z.object({
  name: z.string().min(1).max(120),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

export const repoVisibilitySchema = z.enum(["public", "private"]);
export const collaboratorRoleSchema = z.enum(["reader", "writer"]);

export const createRepoBodySchema = z.object({
  name: repoNameSchema,
  description: z.string().max(2000).optional(),
  /** Defaults to `private` if omitted. */
  visibility: repoVisibilitySchema.optional().default("private"),
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
