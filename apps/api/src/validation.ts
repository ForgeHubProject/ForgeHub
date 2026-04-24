import { z } from "zod";

/** GitHub-style username: alphanumeric + hyphen, no leading/trailing hyphen, 1–39 chars. */
export const handleSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,37}$/);

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
