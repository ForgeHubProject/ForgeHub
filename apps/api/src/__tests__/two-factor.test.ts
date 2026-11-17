/**
 * Password and authentication (#258): TOTP against the RFC vectors, the two-step
 * sign-in, recovery codes, changing your password, and git over HTTPS refusing a
 * bare password for two-factor accounts. Prisma is an in-memory store, so the
 * routes and the auth preHandler run their real logic against it.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  users: [] as Row[],
  sessions: [] as Row[],
  challenges: [] as Row[],
  codes: [] as Row[],
  pats: [] as Row[],
  seq: 0,
}));

vi.mock("../prisma.js", () => {
  const byId = (rows: Row[], id: unknown) => rows.find((r) => r.id === id) ?? null;
  const userWhere = (w: Row) =>
    db.users.find((u) => (w.id && u.id === w.id) || (w.email && u.email === w.email) || (w.handle && u.handle === w.handle)) ?? null;
  return {
    prisma: {
      user: {
        findUnique: vi.fn(async ({ where }: { where: Row }) => userWhere(where)),
        findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => {
          const u = userWhere(where);
          if (!u) throw new Error("not found");
          return u;
        }),
        findFirst: vi.fn(async ({ where }: { where: { OR: Row[] } }) => where.OR.map(userWhere).find(Boolean) ?? null),
        update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => Object.assign(userWhere(where)!, data)),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string; OR: Array<{ totpLastStep: null | { lt: number } }> }; data: Row }) => {
          const u = userWhere({ id: where.id });
          const last = u?.totpLastStep as number | null;
          const ok = u && where.OR.some((c) => (c.totpLastStep === null ? last === null : last !== null && last < c.totpLastStep.lt));
          if (ok) Object.assign(u!, data);
          return { count: ok ? 1 : 0 };
        }),
      },
      session: {
        create: vi.fn(async ({ data }: { data: Row }) => {
          const row = { id: `sess-${++db.seq}`, revokedAt: null, lastSeenAt: new Date(), createdAt: new Date(), ...data };
          db.sessions.push(row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: { where: Row }) => byId(db.sessions, where.id)),
        update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => Object.assign(byId(db.sessions, where.id)!, data)),
        updateMany: vi.fn(async ({ where, data }: { where: { userId: string; id?: { not: string } }; data: Row }) => {
          const hit = db.sessions.filter((s) => s.userId === where.userId && s.revokedAt === null && s.id !== where.id?.not);
          hit.forEach((s) => Object.assign(s, data));
          return { count: hit.length };
        }),
      },
      loginChallenge: {
        create: vi.fn(async ({ data }: { data: Row }) => {
          const row = { id: `ch-${++db.seq}`, attempts: 0, createdAt: new Date(), ...data };
          db.challenges.push(row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: { where: Row }) => db.challenges.find((c) => c.tokenHash === where.tokenHash) ?? null),
        update: vi.fn(async ({ where }: { where: Row }) => {
          const c = byId(db.challenges, where.id)!;
          c.attempts = (c.attempts as number) + 1;
          return c;
        }),
        aggregate: vi.fn(async ({ where }: { where: { userId: string; createdAt: { gte: Date } } }) => ({
          _sum: {
            attempts: db.challenges
              .filter((c) => c.userId === where.userId && (c.createdAt as Date) >= where.createdAt.gte)
              .reduce((n, c) => n + (c.attempts as number), 0),
          },
        })),
        deleteMany: vi.fn(async ({ where }: { where: { userId: string; createdAt?: { lt: Date } } }) => {
          const before = db.challenges.length;
          db.challenges = db.challenges.filter((c) => c.userId !== where.userId || (where.createdAt && (c.createdAt as Date) >= where.createdAt.lt));
          return { count: before - db.challenges.length };
        }),
      },
      recoveryCode: {
        count: vi.fn(async ({ where }: { where: Row }) => db.codes.filter((c) => c.userId === where.userId).length),
        createMany: vi.fn(async ({ data }: { data: Row[] }) => {
          db.codes.push(...data);
          return { count: data.length };
        }),
        deleteMany: vi.fn(async ({ where }: { where: Row }) => {
          const before = db.codes.length;
          db.codes = db.codes.filter((c) => c.userId !== where.userId || (where.codeHash !== undefined && c.codeHash !== where.codeHash));
          return { count: before - db.codes.length };
        }),
      },
      personalAccessToken: {
        findUnique: vi.fn(async ({ where }: { where: Row }) => db.pats.find((p) => p.tokenHash === where.tokenHash) ?? null),
        update: vi.fn(async () => ({})),
      },
      // A public repository someone else owns: pushing to it is "authenticated, but no write access".
      repo: {
        findFirst: vi.fn(async () => ({
          id: "repo-1", ownerId: "someone-else", orgId: null, visibility: "PUBLIC", storageKey: "someone-else/widget.git", collaborators: [],
        })),
      },
      repoRedirect: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
    },
  };
});

import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers/server.js";
import { hashToken } from "../tokens.js";
import {
  base32, decryptSecret, encryptSecret, hashRecoveryCode, matchTotp, newRecoveryCodes, newTotpSecret, otpauthUri, totpCode, totpStep,
} from "../two-factor.js";

// ─── TOTP itself ──────────────────────────────────────────────────────────────

describe("TOTP (RFC 6238, SHA-1, 6 digits, 30 s)", () => {
  const rfcSecret = Buffer.from("12345678901234567890");

  it("matches the RFC 6238 SHA-1 test vectors (their last six digits)", () => {
    const vectors: Array<[seconds: number, code: string]> = [
      [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
      [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) {
      expect(totpCode(rfcSecret, totpStep(seconds * 1000))).toBe(code.slice(-6));
    }
  });

  it("matches the RFC 4226 HOTP test vectors", () => {
    const hotp = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    hotp.forEach((code, counter) => expect(totpCode(rfcSecret, counter)).toBe(code));
  });

  it("accepts one step of drift either way, not two", () => {
    const now = 1_700_000_000_000;
    const t = totpStep(now);
    for (const d of [-1, 0, 1]) expect(matchTotp(rfcSecret, totpCode(rfcSecret, t + d), null, now)).toBe(t + d);
    for (const d of [-2, 2]) expect(matchTotp(rfcSecret, totpCode(rfcSecret, t + d), null, now)).toBeNull();
    expect(matchTotp(rfcSecret, "12345", null, now)).toBeNull();
    expect(matchTotp(rfcSecret, "abcdef", null, now)).toBeNull();
  });

  it("refuses a code from a step already used, or an earlier one", () => {
    const now = 1_700_000_000_000;
    const t = totpStep(now);
    expect(matchTotp(rfcSecret, totpCode(rfcSecret, t), t, now)).toBeNull();
    expect(matchTotp(rfcSecret, totpCode(rfcSecret, t - 1), t, now)).toBeNull();
    expect(matchTotp(rfcSecret, totpCode(rfcSecret, t + 1), t, now)).toBe(t + 1);
  });

  it("encodes base32 the RFC 4648 way and builds the otpauth URI", () => {
    expect(base32(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32(rfcSecret)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(otpauthUri(rfcSecret, "ada")).toBe(
      "otpauth://totp/ForgeHub:ada?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ForgeHub&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("encrypts the secret at rest, readable only under the same JWT_SECRET", () => {
    const secret = newTotpSecret();
    const stored = encryptSecret(secret);
    expect(stored).not.toContain(base32(secret));
    expect(decryptSecret(stored)).toEqual(secret);
    expect(decryptSecret(stored.slice(0, -2) + "AA")).toBeNull();
    const saved = process.env["JWT_SECRET"];
    process.env["JWT_SECRET"] = "a-different-secret-at-least-16";
    try {
      expect(decryptSecret(stored)).toBeNull();
    } finally {
      process.env["JWT_SECRET"] = saved;
    }
  });

  it("makes ten distinct recovery codes, hashed regardless of case and dashes", () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{5}(-[0-9a-f]{5}){3}$/);
    expect(hashRecoveryCode(codes[0].toUpperCase().replace(/-/g, " "))).toBe(hashRecoveryCode(codes[0]));
  });
});

// ─── The routes ───────────────────────────────────────────────────────────────

const PASSWORD = "hunter22";
let app: FastifyInstance;
let passwordHash: string;
beforeAll(async () => {
  app = await createTestServer();
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});
afterAll(async () => {
  await app.close();
});

const secret = Buffer.from("0123456789abcdefghij");
function seedUser(twoFactor: boolean, extra: Row = {}) {
  db.users = [{
    id: "u1", email: "ada@x.io", handle: "ada", displayName: null, bio: null, location: null, website: null,
    emailNotifications: false, avatarKey: null, createdAt: new Date("2026-01-01"), passwordHash,
    totpSecret: twoFactor ? encryptSecret(secret) : null, totpEnabledAt: twoFactor ? new Date() : null, totpLastStep: null, ...extra,
  }];
}
beforeEach(() => {
  db.sessions = [];
  db.challenges = [];
  db.codes = [];
  db.pats = [];
  seedUser(true);
});

const login = (password = PASSWORD) => app.inject({ method: "POST", url: "/auth/login", payload: { email: "ada", password } });
const second = (challenge: string, code: string) => app.inject({ method: "POST", url: "/auth/login/2fa", payload: { challenge, code } });
const me = (authorization: string) => app.inject({ method: "GET", url: "/auth/me", headers: { authorization } });
const nowCode = () => totpCode(secret, totpStep());

describe("signing in with two-factor on", () => {
  it("the password step gives a challenge, not a session, and the challenge is no session", async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ twoFactorRequired: true, challenge: expect.any(String) });
    expect(db.sessions).toHaveLength(0);
    expect((await me(`Bearer ${body.challenge}`)).statusCode).toBe(401);
    expect(db.challenges[0].tokenHash).toBe(hashToken(body.challenge));
  });

  it("a wrong password still gets no challenge", async () => {
    expect((await login("wrong-password")).statusCode).toBe(401);
    expect(db.challenges).toHaveLength(0);
  });

  it("a code from the app turns the challenge into a session, once", async () => {
    const { challenge } = (await login()).json();
    const res = await second(challenge, nowCode());
    expect(res.statusCode).toBe(200);
    expect(res.json().user.handle).toBe("ada");
    expect((await me(`Bearer ${res.json().token}`)).statusCode).toBe(200);
    // The challenge is spent, and the same code can't sign in again.
    expect((await second(challenge, nowCode())).statusCode).toBe(401);
    const again = (await login()).json().challenge;
    expect((await second(again, nowCode())).json()).toEqual({ error: "Incorrect code" });
  });

  it("a recovery code works once", async () => {
    db.codes = [{ userId: "u1", codeHash: hashRecoveryCode("aaaaa-bbbbb-ccccc-ddddd") }];
    const first = await second((await login()).json().challenge, "AAAAA-BBBBB-CCCCC-DDDDD");
    expect(first.statusCode).toBe(200);
    expect(db.codes).toHaveLength(0);
    expect((await second((await login()).json().challenge, "aaaaa-bbbbb-ccccc-ddddd")).statusCode).toBe(401);
  });

  it("locks the second step after ten wrong codes, even for the right one", async () => {
    const { challenge } = (await login()).json();
    const wrong = nowCode() === "000000" ? "111111" : "000000";
    for (let i = 0; i < 10; i++) expect((await second(challenge, wrong)).statusCode).toBe(401);
    expect((await second(challenge, nowCode())).statusCode).toBe(429);
    // A fresh challenge doesn't reset it: the count is the account's.
    expect((await second((await login()).json().challenge, nowCode())).statusCode).toBe(429);
    expect(db.sessions).toHaveLength(0);
  });

  it("refuses an expired or unknown challenge", async () => {
    const { challenge } = (await login()).json();
    db.challenges[0].expiresAt = new Date(Date.now() - 1);
    expect((await second(challenge, nowCode())).statusCode).toBe(401);
    expect((await second("made-up", nowCode())).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login/2fa", payload: { challenge } })).statusCode).toBe(400);
  });

  it("without two-factor, the password still signs straight in", async () => {
    seedUser(false);
    const res = await login();
    expect(res.json().token).toBeTruthy();
    expect(db.challenges).toHaveLength(0);
  });
});

describe("turning two-factor on and off", () => {
  beforeEach(() => seedUser(false));

  it("setup shows the secret; enabling needs the password and a code; the codes are stored hashed", async () => {
    const auth = `Bearer ${(await login()).json().token}`;
    const setup = await app.inject({ method: "POST", url: "/users/me/two-factor/setup", headers: { authorization: auth } });
    const { secret: b32, uri } = setup.json();
    expect(uri).toContain(`secret=${b32}`);
    const stored = decryptSecret(db.users[0].totpSecret as string)!;
    expect(base32(stored)).toBe(b32);
    expect(db.users[0].totpEnabledAt).toBeNull();

    const enable = (payload: object) => app.inject({ method: "POST", url: "/users/me/two-factor/enable", headers: { authorization: auth }, payload });
    expect((await enable({ password: "wrong", code: totpCode(stored, totpStep()) })).statusCode).toBe(403);
    expect((await enable({ password: PASSWORD, code: "000000" === totpCode(stored, totpStep()) ? "111111" : "000000" })).statusCode).toBe(400);
    const on = await enable({ password: PASSWORD, code: totpCode(stored, totpStep()) });
    expect(on.statusCode).toBe(200);
    const codes = on.json().recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(db.codes.map((c) => c.codeHash)).toEqual(codes.map(hashRecoveryCode));
    expect(JSON.stringify(db.codes)).not.toContain(codes[0]);
    expect(db.users[0].totpEnabledAt).toBeInstanceOf(Date);

    const status = await app.inject({ method: "GET", url: "/users/me/two-factor", headers: { authorization: auth } });
    expect(status.json()).toEqual({ enabled: true, recoveryCodesLeft: 10 });
    expect((await app.inject({ method: "POST", url: "/users/me/two-factor/setup", headers: { authorization: auth } })).statusCode).toBe(409);
  });

  it("regenerating replaces the recovery codes; turning off needs the password", async () => {
    const auth = `Bearer ${(await login()).json().token}`;
    db.users[0].totpSecret = encryptSecret(secret);
    db.users[0].totpEnabledAt = new Date();
    db.codes = [{ userId: "u1", codeHash: hashRecoveryCode("old") }];

    const regen = await app.inject({ method: "POST", url: "/users/me/two-factor/recovery-codes", headers: { authorization: auth }, payload: { password: PASSWORD } });
    expect(regen.json().recoveryCodes).toHaveLength(10);
    expect(db.codes.some((c) => c.codeHash === hashRecoveryCode("old"))).toBe(false);

    const off = (password: string) => app.inject({ method: "DELETE", url: "/users/me/two-factor", headers: { authorization: auth }, payload: { password } });
    expect((await off("wrong")).statusCode).toBe(403);
    expect(db.users[0].totpEnabledAt).not.toBeNull();
    expect((await off(PASSWORD)).statusCode).toBe(204);
    expect(db.users[0]).toMatchObject({ totpSecret: null, totpEnabledAt: null });
    expect(db.codes).toHaveLength(0);
  });

  it("refuses personal access tokens", async () => {
    db.pats = [{ id: "pat", userId: "u1", tokenHash: hashToken("fhp_admin"), scopes: "repo:read,repo:write,admin", expiresAt: null }];
    const res = await app.inject({ method: "POST", url: "/users/me/two-factor/setup", headers: { authorization: "Bearer fhp_admin" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("changing your password", () => {
  beforeEach(() => seedUser(false));
  const change = (authorization: string, payload: object) =>
    app.inject({ method: "POST", url: "/users/me/password", headers: { authorization }, payload });

  // Long timeout: the new password is hashed at the real bcrypt cost (12), slow in a loaded suite.
  it("needs the current password and a valid new one, then signs out every other session", async () => {
    const mine = `Bearer ${(await login()).json().token}`;
    const other = `Bearer ${(await login()).json().token}`;
    expect((await change(mine, { currentPassword: "wrong", newPassword: "a-new-password" })).statusCode).toBe(403);
    expect((await change(mine, { currentPassword: PASSWORD, newPassword: "short" })).statusCode).toBe(400);
    expect((await me(other)).statusCode).toBe(200);

    expect((await change(mine, { currentPassword: PASSWORD, newPassword: "a-new-password" })).statusCode).toBe(204);
    expect(await bcrypt.compare("a-new-password", db.users[0].passwordHash as string)).toBe(true);
    expect((await me(mine)).statusCode).toBe(200);
    expect((await me(other)).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(401);
    expect((await login("a-new-password")).statusCode).toBe(200);
  }, 30_000);

  it("refuses personal access tokens", async () => {
    db.pats = [{ id: "pat", userId: "u1", tokenHash: hashToken("fhp_admin"), scopes: "admin", expiresAt: null }];
    expect((await change("Bearer fhp_admin", { currentPassword: PASSWORD, newPassword: "a-new-password" })).statusCode).toBe(403);
  });
});

describe("git over HTTPS", () => {
  const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  // 403 = signed in (but no write access to someone else's repository); 401 = not signed in.
  const push = (authorization: string) =>
    app.inject({ method: "GET", url: "/git/someone-else/widget.git/info/refs?service=git-receive-pack", headers: { authorization } });

  it("refuses the password of a two-factor account, but takes its token", async () => {
    expect((await push(basic("ada", PASSWORD))).statusCode).toBe(401);
    expect((await push(basic("ada@x.io", PASSWORD))).statusCode).toBe(401);
    db.pats = [{ id: "pat", userId: "u1", tokenHash: hashToken("fhp_tok"), scopes: "repo:read,repo:write", expiresAt: null }];
    expect((await push(basic("ada", "fhp_tok"))).statusCode).toBe(403);
  });

  it("takes the password without two-factor", async () => {
    seedUser(false);
    expect((await push(basic("ada", PASSWORD))).statusCode).toBe(403);
  });

  it("refuses the challenge, and a revoked session's token", async () => {
    const { challenge } = (await login()).json();
    expect((await push(basic("ada", challenge))).statusCode).toBe(401);
    expect((await push(`Bearer ${challenge}`)).statusCode).toBe(401);

    seedUser(false);
    const token = (await login()).json().token;
    expect((await push(basic("x", token))).statusCode).toBe(403);
    db.sessions[0].revokedAt = new Date();
    expect((await push(basic("x", token))).statusCode).toBe(401);
    expect((await push(`Bearer ${token}`)).statusCode).toBe(401);
  });
});
