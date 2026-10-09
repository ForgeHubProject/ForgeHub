/**
 * Wire-level tests for the repo API wrappers touched by issue #109: the
 * updateRepo/deleteRepo additions and listCommits forwarding the query params
 * the server actually reads (page/per_page/path). fetch is stubbed — these
 * assert the request shape, not server behavior (covered in apps/api).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCollaborator, deleteRepo, listCollaborators, listCommits, removeCollaborator, updateRepo, updateRepoMergePolicy } from "../api";

function stubFetch(status = 200, body: unknown = {}) {
  const mock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listCommits", () => {
  it("forwards branch, path, page, and per_page", async () => {
    const mock = stubFetch(200, { commits: [], branch: "main", path: "src", page: 2, perPage: 50 });
    await listCommits("tok", "alice", "demo", "main", { path: "src", page: 2, perPage: 50 });
    const [url] = mock.mock.calls[0]!;
    expect(String(url)).toContain("/repos/alice/demo/commits?");
    const qs = new URL(String(url)).searchParams;
    expect(qs.get("branch")).toBe("main");
    expect(qs.get("path")).toBe("src");
    expect(qs.get("page")).toBe("2");
    expect(qs.get("per_page")).toBe("50");
  });

  it("omits every param it wasn't given", async () => {
    const mock = stubFetch(200, { commits: [], branch: "main", path: null, page: 1, perPage: 20 });
    await listCommits(null, "alice", "demo");
    const [url] = mock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/repos\/alice\/demo\/commits$/);
  });
});

// Settings are addressed by owner + name (#217): the legacy name-only routes can
// only find the caller's own personal repo, so they never reach an org repo.
describe("updateRepo", () => {
  it("PATCHes the owner-scoped settings route with the JSON patch", async () => {
    const mock = stubFetch(200, { name: "demo", visibility: "public" });
    await updateRepo("tok", "acme", "demo", { description: null, visibility: "public" });
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/repos\/acme\/demo\/settings$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ description: null, visibility: "public" });
    expect(init.headers.Authorization).toBe("Bearer tok");
  });
});

describe("deleteRepo", () => {
  it("DELETEs the repo addressed by owning handle and name", async () => {
    // The owner must be part of the address: a bare name resolves against the
    // CALLER's namespace server-side, so deleting while viewing someone else's
    // repo would hit the caller's same-named repo instead.
    const mock = stubFetch(204);
    await deleteRepo("tok", "bob", "demo");
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/repos\/bob\/demo$/);
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("rejects rather than resolving when the server refuses", async () => {
    // The success toast is gated on this promise, so a refusal must not resolve.
    stubFetch(404, { error: "Repository not found" });
    await expect(deleteRepo("tok", "bob", "demo")).rejects.toThrow("Repository not found");
  });
});

describe("owner-scoped settings calls (#217)", () => {
  it("sends the merge policy to the settings route", async () => {
    const mock = stubFetch(200, { name: "demo" });
    await updateRepoMergePolicy("tok", "acme", "demo", ["squash"], "squash");
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/repos\/acme\/demo\/settings$/);
    expect(init.method).toBe("PATCH");
  });

  it("lists, adds and removes collaborators under the owner", async () => {
    const mock = stubFetch(200, { collaborators: [] });
    await listCollaborators("tok", "acme", "demo");
    await addCollaborator("tok", "acme", "demo", "bob", "writer");
    await removeCollaborator("tok", "acme", "demo", "bob");
    const calls = mock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url).replace(/^.*?\/repos/, "/repos")}`);
    expect(calls).toEqual([
      "GET /repos/acme/demo/collaborators",
      "POST /repos/acme/demo/collaborators",
      "DELETE /repos/acme/demo/collaborators/bob",
    ]);
  });
});
