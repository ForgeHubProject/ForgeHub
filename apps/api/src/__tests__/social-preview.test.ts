/**
 * Social preview (#256): admins upload the image a shared link shows, anyone who
 * can read the repository gets it, and link previews — which never run the app —
 * get a page of title, description and image tags from /_preview/<page path>.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    pullRequest: { findFirst: vi.fn() },
    issue: { findFirst: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { buildServer } from "../server.js";
import { authHeader } from "./helpers/server.js";
import { detectSocialPreviewType } from "../routes/social-preview.js";
import type { FastifyInstance } from "fastify";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), randomBytes(32)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([16, 0, 0, 0]), Buffer.from("WEBP"), randomBytes(16)]);

function multipart(buf: Buffer, filename = "card.png") {
  const boundary = "----fhtest" + randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, buf, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

type RepoFixture = Record<string, unknown>;
function repo(over: RepoFixture = {}): RepoFixture {
  return {
    id: "repo-1",
    name: "lanternfall",
    description: "A small Godot 4 cave adventure",
    visibility: "PUBLIC",
    ownerId: "user-1",
    orgId: null,
    org: null,
    archivedAt: null,
    collaborators: [],
    teamAccess: [],
    socialPreviewKey: null,
    owner: { handle: "ada", avatarKey: null },
    ...over,
  };
}

let app: FastifyInstance;
let admin: string;
let reader: string;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "fh-social-preview-"));
  process.env["GIT_STORAGE_ROOT"] = storageRoot;
  process.env["JWT_SECRET"] = "test-secret-at-least-16-chars";
  app = await buildServer();
  admin = await authHeader(app, "user-1");
  reader = await authHeader(app, "user-2");
}, 30_000);

afterAll(async () => {
  await app.close();
  delete process.env["GIT_STORAGE_ROOT"];
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo() as never);
  vi.mocked(prisma.repo.update).mockResolvedValue({} as never);
});

afterEach(() => {
  delete process.env["PUBLIC_URL"];
});

const upload = (buf: Buffer, who = admin) => {
  const body = multipart(buf);
  return app.inject({
    method: "POST",
    url: "/repos/ada/lanternfall/social-preview",
    headers: { ...body.headers, authorization: who },
    payload: body.payload,
  });
};

describe("detectSocialPreviewType", () => {
  it("takes PNG, JPG and GIF, as GitHub does, and nothing else", () => {
    expect(detectSocialPreviewType(PNG)).toBe("image/png");
    expect(detectSocialPreviewType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe("image/jpeg");
    expect(detectSocialPreviewType(GIF)).toBe("image/gif");
    expect(detectSocialPreviewType(WEBP)).toBeNull();
    expect(detectSocialPreviewType(Buffer.from("<svg/>"))).toBeNull();
  });
});

describe("uploading and serving the image", () => {
  it("an admin uploads it; anyone reads the same bytes, cached for good at the versioned URL", async () => {
    const res = await upload(PNG);
    expect(res.statusCode).toBe(201);
    const { socialPreviewKey } = res.json();
    expect(socialPreviewKey).toMatch(/^[0-9a-f]{16}$/);
    expect(vi.mocked(prisma.repo.update)).toHaveBeenCalledWith({ where: { id: "repo-1" }, data: { socialPreviewKey } });

    vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo({ socialPreviewKey }) as never);
    const served = await app.inject({ method: "GET", url: `/repos/ada/lanternfall/social-preview?v=${socialPreviewKey}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.rawPayload.equals(PNG)).toBe(true);
    expect(served.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const unversioned = await app.inject({ method: "GET", url: "/repos/ada/lanternfall/social-preview" });
    expect(unversioned.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("takes a GIF, and refuses other formats and anything from 1 MB up", async () => {
    expect((await upload(GIF)).statusCode).toBe(201);
    const webp = await upload(WEBP);
    expect(webp.statusCode).toBe(400);
    expect(webp.json().error).toBe("The image must be a PNG, JPG or GIF");
    const big = await upload(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]));
    expect(big.statusCode).toBe(413);
    expect(vi.mocked(prisma.repo.update)).toHaveBeenCalledTimes(1);
  });

  it("is the admins' to change: 403 for a reader, 404 where they can't even read", async () => {
    expect((await upload(PNG, reader)).statusCode).toBe(403);
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo({ visibility: "PRIVATE" }) as never);
    expect((await upload(PNG, reader)).statusCode).toBe(404);
    const removal = await app.inject({ method: "DELETE", url: "/repos/ada/lanternfall/social-preview", headers: { authorization: reader } });
    expect(removal.statusCode).toBe(404);
    expect(vi.mocked(prisma.repo.update)).not.toHaveBeenCalled();
  });

  it("removing it clears the key, and the image is gone", async () => {
    const { socialPreviewKey } = (await upload(PNG)).json();
    const removal = await app.inject({ method: "DELETE", url: "/repos/ada/lanternfall/social-preview", headers: { authorization: admin } });
    expect(removal.statusCode).toBe(204);
    expect(vi.mocked(prisma.repo.update)).toHaveBeenLastCalledWith({ where: { id: "repo-1" }, data: { socialPreviewKey: null } });
    // Even a stale row still naming the key finds no file.
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo({ socialPreviewKey }) as never);
    expect((await app.inject({ method: "GET", url: "/repos/ada/lanternfall/social-preview" })).statusCode).toBe(404);
  });

  it("a private repository's image is for its readers only", async () => {
    const { socialPreviewKey } = (await upload(PNG)).json();
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo({ visibility: "PRIVATE", socialPreviewKey }) as never);
    expect((await app.inject({ method: "GET", url: "/repos/ada/lanternfall/social-preview" })).statusCode).toBe(404);
    const own = await app.inject({ method: "GET", url: "/repos/ada/lanternfall/social-preview", headers: { authorization: admin } });
    expect(own.statusCode).toBe(200);
    expect(own.headers["cache-control"]).toBe("private, max-age=300");
  });
});

describe("GET /_preview/<page path>, what a link preview reads", () => {
  const card = async (path: string, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: "GET", url: `/_preview${path}`, headers: { host: "forge.example", ...headers } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    return res.body;
  };
  const tag = (html: string, key: string) =>
    new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html)?.[1] ?? null;

  it("a repository with an image: its name, description and the large image", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo({ socialPreviewKey: "k1" }) as never);
    process.env["PUBLIC_URL"] = "https://forgehubcode.com/";
    const html = await card("/ada/lanternfall");
    expect(tag(html, "og:title")).toBe("ada/lanternfall");
    expect(tag(html, "og:description")).toBe("A small Godot 4 cave adventure");
    expect(tag(html, "og:url")).toBe("https://forgehubcode.com/ada/lanternfall");
    expect(tag(html, "og:image")).toBe("https://forgehubcode.com/repos/ada/lanternfall/social-preview?v=k1");
    expect(tag(html, "twitter:card")).toBe("summary_large_image");
  });

  it("without one, the owner's avatar as a small card; the address from the request when PUBLIC_URL is unset", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo({ owner: { handle: "ada", avatarKey: "av9" } }) as never);
    const html = await card("/ada/lanternfall/tree/main", { "x-forwarded-proto": "https" });
    expect(tag(html, "og:image")).toBe("https://forge.example/users/ada/avatar?v=av9");
    expect(tag(html, "twitter:card")).toBe("summary");
    expect(tag(html, "og:url")).toBe("https://forge.example/ada/lanternfall/tree/main");
  });

  it("a pull request or an issue: its title, and its first lines", async () => {
    vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue({ title: "Cavern 01: side passage", description: "Adds a **second exit**.\n\nPillar B moves." } as never);
    const pr = await card("/ada/lanternfall/pulls/3/files");
    expect(tag(pr, "og:title")).toBe("Cavern 01: side passage · Pull request #3 · ada/lanternfall");
    expect(tag(pr, "og:description")).toBe("Adds a **second exit**. Pillar B moves.");
    expect(vi.mocked(prisma.pullRequest.findFirst)).toHaveBeenCalledWith(expect.objectContaining({ where: { repoId: "repo-1", number: 3 } }));

    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ title: "Moths clip through the lantern", body: null } as never);
    const issue = await card("/ada/lanternfall/issues/5");
    expect(tag(issue, "og:title")).toBe("Moths clip through the lantern · Issue #5 · ada/lanternfall");
    expect(tag(issue, "og:description")).toBe("A small Godot 4 cave adventure");
  });

  it("a private repository shows nothing of itself", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo({ visibility: "PRIVATE", socialPreviewKey: "k1" }) as never);
    const html = await card("/ada/lanternfall");
    expect(tag(html, "og:title")).toBe("ForgeHub");
    expect(html).not.toContain("lanternfall");
    expect(html).not.toContain("Godot");
  });

  it("escapes what people wrote", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo({ description: `"><script>alert(1)</script> & co` }) as never);
    const html = await card("/ada/lanternfall");
    expect(html).not.toContain("<script>");
    expect(tag(html, "og:description")).toBe("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
  });

  it("a profile, and the site itself", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "ada", displayName: "Ada L.", bio: "Builds caves.", avatarKey: null } as never);
    const profile = await card("/ada");
    expect(tag(profile, "og:title")).toBe("Ada L. (ada)");
    expect(tag(profile, "og:description")).toBe("Builds caves.");

    const home = await card("/");
    expect(tag(home, "og:title")).toBe("ForgeHub");
    expect(tag(home, "og:image")).toBeNull();
  });
});
