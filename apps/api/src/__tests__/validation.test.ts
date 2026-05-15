import { describe, it, expect } from "vitest";
import {
  handleSchema,
  repoNameSchema,
  registerBodySchema,
  loginBodySchema,
  createRepoBodySchema,
  updateRepoBodySchema,
  renameRepoBodySchema,
  addCollaboratorBodySchema,
} from "../validation.js";

describe("handleSchema", () => {
  it("accepts plain alphanumeric", () => {
    expect(handleSchema.safeParse("alice").success).toBe(true);
    expect(handleSchema.safeParse("Alice123").success).toBe(true);
  });

  it("accepts internal hyphens", () => {
    expect(handleSchema.safeParse("alice-smith").success).toBe(true);
  });

  it("rejects leading hyphen", () => {
    expect(handleSchema.safeParse("-alice").success).toBe(false);
  });

  it("rejects trailing hyphen", () => {
    expect(handleSchema.safeParse("alice-").success).toBe(false);
  });

  it("rejects double consecutive hyphens", () => {
    expect(handleSchema.safeParse("a--b").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(handleSchema.safeParse("").success).toBe(false);
  });

  it("rejects string longer than 39 characters", () => {
    expect(handleSchema.safeParse("a".repeat(40)).success).toBe(false);
  });

  it("accepts exactly 39 characters", () => {
    expect(handleSchema.safeParse("a".repeat(39)).success).toBe(true);
  });

  it("rejects underscores", () => {
    expect(handleSchema.safeParse("alice_smith").success).toBe(false);
  });

  it("rejects spaces", () => {
    expect(handleSchema.safeParse("alice smith").success).toBe(false);
  });
});

describe("repoNameSchema", () => {
  it("accepts alphanumeric with dots, hyphens, underscores", () => {
    expect(repoNameSchema.safeParse("my-repo.v1_2").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(repoNameSchema.safeParse("").success).toBe(false);
  });

  it("rejects spaces", () => {
    expect(repoNameSchema.safeParse("my repo").success).toBe(false);
  });

  it("rejects slashes", () => {
    expect(repoNameSchema.safeParse("a/b").success).toBe(false);
  });

  it("rejects names over 100 characters", () => {
    expect(repoNameSchema.safeParse("a".repeat(101)).success).toBe(false);
  });
});

describe("registerBodySchema", () => {
  const valid = {
    email: "alice@example.com",
    password: "hunter12",
    handle: "alice",
  };

  it("accepts valid registration body", () => {
    expect(registerBodySchema.safeParse(valid).success).toBe(true);
  });

  it("accepts optional displayName", () => {
    const result = registerBodySchema.safeParse({ ...valid, displayName: "Alice Smith" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid email", () => {
    expect(registerBodySchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });

  it("rejects password shorter than 8 characters", () => {
    expect(registerBodySchema.safeParse({ ...valid, password: "short" }).success).toBe(false);
  });

  it("rejects password longer than 128 characters", () => {
    expect(registerBodySchema.safeParse({ ...valid, password: "x".repeat(129) }).success).toBe(false);
  });

  it("rejects invalid handle", () => {
    expect(registerBodySchema.safeParse({ ...valid, handle: "-bad" }).success).toBe(false);
  });

  it("rejects missing email", () => {
    const { email: _e, ...rest } = valid;
    expect(registerBodySchema.safeParse(rest).success).toBe(false);
  });
});

describe("loginBodySchema", () => {
  it("accepts valid login body", () => {
    const result = loginBodySchema.safeParse({ email: "alice@example.com", password: "anything" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid email", () => {
    expect(loginBodySchema.safeParse({ email: "bad", password: "pass" }).success).toBe(false);
  });

  it("rejects empty password", () => {
    expect(loginBodySchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
  });
});

describe("createRepoBodySchema", () => {
  it("defaults visibility to private when omitted", () => {
    const result = createRepoBodySchema.safeParse({ name: "my-repo" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.visibility).toBe("private");
  });

  it("accepts explicit public visibility", () => {
    const result = createRepoBodySchema.safeParse({ name: "my-repo", visibility: "public" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.visibility).toBe("public");
  });

  it("rejects invalid visibility value", () => {
    expect(createRepoBodySchema.safeParse({ name: "my-repo", visibility: "protected" }).success).toBe(false);
  });

  it("rejects description over 2000 characters", () => {
    expect(createRepoBodySchema.safeParse({ name: "my-repo", description: "x".repeat(2001) }).success).toBe(false);
  });
});

describe("updateRepoBodySchema", () => {
  it("accepts empty object (no-op update)", () => {
    expect(updateRepoBodySchema.safeParse({}).success).toBe(true);
  });

  it("accepts null description (clear it)", () => {
    expect(updateRepoBodySchema.safeParse({ description: null }).success).toBe(true);
  });

  it("accepts visibility change alone", () => {
    expect(updateRepoBodySchema.safeParse({ visibility: "public" }).success).toBe(true);
  });
});

describe("renameRepoBodySchema", () => {
  it("accepts valid new name", () => {
    expect(renameRepoBodySchema.safeParse({ name: "new-name" }).success).toBe(true);
  });

  it("rejects missing name", () => {
    expect(renameRepoBodySchema.safeParse({}).success).toBe(false);
  });
});

describe("addCollaboratorBodySchema", () => {
  it("defaults role to reader when omitted", () => {
    const result = addCollaboratorBodySchema.safeParse({ handle: "bob" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.role).toBe("reader");
  });

  it("accepts explicit writer role", () => {
    const result = addCollaboratorBodySchema.safeParse({ handle: "bob", role: "writer" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.role).toBe("writer");
  });

  it("rejects invalid role", () => {
    expect(addCollaboratorBodySchema.safeParse({ handle: "bob", role: "admin" }).success).toBe(false);
  });

  it("rejects invalid handle", () => {
    expect(addCollaboratorBodySchema.safeParse({ handle: "--bad" }).success).toBe(false);
  });
});
