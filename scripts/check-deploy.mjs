#!/usr/bin/env node
/**
 * After a release: check a running ForgeHub the way visitors, browsers and git
 * meet it, through every proxy in front of it. Each check is a mistake that
 * reached forgehubcode.com once and that development (two origins, SQLite)
 * never shows.
 *
 *   node scripts/check-deploy.mjs https://forgehubcode.com [--repo owner/name]
 *
 * --repo names a public repository to read (default: the first one Explore
 * lists); one with a 3D model in its history also gets the diff checked.
 *
 * Signed out and read-only, with one exception: the upload check sends 8 MB
 * twice, to endpoints that turn it away for want of sign-in, to prove nothing
 * in front of the API refuses a big upload first. Exits 1 if any check fails.
 */
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/check-deploy.mjs <https://host> [--repo owner/name]";
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const repoFlag = argv.indexOf("--repo");
let repo = repoFlag >= 0 ? argv[repoFlag + 1] : null;
const target = argv.find((a, i) => !a.startsWith("--") && (repoFlag < 0 || i !== repoFlag + 1));
if (!target || (repoFlag >= 0 && !/^[\w.-]+\/[\w.-]+$/.test(repo ?? ""))) {
  console.error(USAGE);
  process.exit(2);
}
const base = new URL(target);
const checkout = fileURLToPath(new URL("..", import.meta.url));

/** What a browser asks for when it opens a page: a link, a refresh, a bookmark. */
const PAGE = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const MODEL_EXTS = [".glb", ".gltf", ".obj", ".stl", ".3mf", ".x3d"];
const UPLOAD_BYTES = 8 * 1024 * 1024;

function request(path, { accept = "application/json", ...init } = {}) {
  return fetch(new URL(path, base), {
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
    ...init,
    headers: { accept, ...init.headers },
  });
}
const type = (res) => (res.headers.get("content-type") ?? "").split(";")[0] || "no content type";
const isJson = (res) => type(res) === "application/json";
const isHtml = (res) => type(res) === "text/html";
const short = (sha) => String(sha).slice(0, 7);
const enc = encodeURIComponent;

async function json(path) {
  const res = await request(path);
  if (!isJson(res)) throw new Error(`${path} answered ${res.status} ${type(res)}, not JSON`);
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

const results = [];
async function check(name, run) {
  try {
    const out = (await run()) ?? {};
    const problems = out.problems ?? [];
    results.push({
      name,
      status: problems.length ? "FAIL" : (out.status ?? "PASS"),
      detail: problems.length ? problems : [out.detail ?? ""],
    });
  } catch (err) {
    results.push({ name, status: "FAIL", detail: [err?.cause?.code ? `${err.message} (${err.cause.code})` : String(err?.message ?? err)] });
  }
}

// ── Server: which build is live, and is it alive ─────────────────────────────
let info = null;
await check("Server", async () => {
  info = await json("/server/info");
  const health = await json("/health");
  if (health.ok !== true) return { problems: [`/health answered ${JSON.stringify(health)}`] };
  const build = info.build;
  if (!build?.revision) {
    return { status: "WARN", detail: "doesn't say which commit it runs (built before /server/info reported it)" };
  }
  let detail = `${build.version ?? "unversioned"} from ${short(build.revision)}`;
  try {
    const git = (...a) => execFileSync("git", a, { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const behind = Number(git("rev-list", "--count", `${build.revision}..origin/main`));
    detail += behind === 0 ? ", which has everything in origin/main" : `, ${behind} commit${behind === 1 ? "" : "s"} behind origin/main`;
  } catch {
    // Not run from a checkout that knows this commit; the build alone is still useful.
  }
  return { detail };
});

// A repository to read: the one asked for, or the first Explore lists.
if (!repo) {
  try {
    const first = (await json("/explore/repos")).repos?.[0];
    if (first) repo = first.fullName ?? `${first.ownerHandle}/${first.name}`;
  } catch {
    // Reported by the API check below; repository checks are skipped.
  }
}

// ── Pages: opening any URL in a browser gets the app ─────────────────────────
let indexHtml = "";
await check("Pages", async () => {
  const paths = ["/", "/login", "/explore", "/search?q=forge", "/notifications", "/feed"];
  if (repo) paths.push(`/${repo}`, `/${repo}/pulls`, `/${repo}/issues`, `/${repo}/commits`);
  const problems = [];
  for (const path of paths) {
    const res = await request(path, { accept: PAGE });
    const body = await res.text();
    if (res.status !== 200 || !isHtml(res) || !body.includes('id="root"')) {
      problems.push(`${path} answered ${res.status} ${type(res)}, not the app`);
    } else if (path === "/") indexHtml = body;
  }
  return { problems, detail: `${paths.length} pages open as the app` };
});

// ── Assets: the app's scripts and styles, not the page in their place ────────
await check("Assets", async () => {
  if (!indexHtml) return { problems: ["no app page to read assets from"] };
  const assets = [...new Set([...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
  if (!assets.length) return { problems: ["the app page links no /assets/ files"] };
  const problems = [];
  for (const path of assets) {
    const res = await request(path, { accept: "*/*" });
    await res.arrayBuffer();
    const want = path.endsWith(".css") ? /css/ : path.endsWith(".js") ? /javascript/ : /./;
    if (res.status !== 200 || isHtml(res) || !want.test(type(res))) problems.push(`${path} answered ${res.status} ${type(res)}`);
  }
  return { problems, detail: `${assets.length} scripts and styles load` };
});

// ── API: the app's requests reach the API, signed out ────────────────────────
await check("API", async () => {
  const problems = [];
  // Paths that are a page as well: the app's fetch must get the API, whatever it answers.
  for (const path of ["/explore", "/search?q=forge", "/feed", "/notifications"]) {
    const res = await request(path);
    await res.arrayBuffer();
    if (!isJson(res) || res.status >= 500) problems.push(`${path} answered ${res.status} ${type(res)}, not the API`);
  }
  const reads = ["/explore/repos"];
  if (repo) reads.push(`/repos/${repo}`, `/repos/${repo}/branches`, `/repos/${repo}/commits`);
  for (const path of reads) {
    try {
      await json(path);
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { problems, detail: repo ? `reads ${repo} signed out` : "answers signed out" };
});

// ── Git over HTTPS: a public clone starts ────────────────────────────────────
await check("Git clone", async () => {
  if (!repo) return { status: "SKIP", detail: "no public repository found; pass --repo owner/name" };
  const res = await request(`/git/${repo}.git/info/refs?service=git-upload-pack`, { accept: "*/*" });
  const body = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200 || type(res) !== "application/x-git-upload-pack-advertisement") {
    return { problems: [`info/refs answered ${res.status} ${type(res)}`] };
  }
  const refs = body.toString("latin1").match(/[0-9a-f]{40} refs\/heads\//g)?.length ?? 0;
  return { detail: `git sees ${refs} branch${refs === 1 ? "" : "es"} over HTTPS` };
});

// ── 3D diff and raw file: the semantic diff runs and the model downloads ─────
await check("3D diff", async () => {
  if (!repo) return { status: "SKIP", detail: "no public repository found; pass --repo owner/name" };
  const { commits } = await json(`/repos/${repo}/commits?per_page=30`);
  let found = null;
  for (const commit of commits ?? []) {
    const { files } = await json(`/repos/${repo}/commits/${commit.sha}/diff`);
    const file = (files ?? []).find((f) => f.status !== "deleted" && MODEL_EXTS.some((e) => f.newPath?.toLowerCase().endsWith(e)));
    if (file) {
      found = { path: file.newPath, sha: commit.sha };
      break;
    }
  }
  if (!found) return { status: "SKIP", detail: `no 3D model in the last 30 commits of ${repo}` };
  const at = `${found.path} at ${short(found.sha)}`;

  const res = await request(`/repos/${repo}/filediff?path=${enc(found.path)}&sha=${found.sha}`);
  const diff = isJson(res) ? await res.json() : null;
  if (!res.ok || !diff) return { problems: [`diff of ${at} answered ${res.status} ${type(res)}`] };
  if (diff.status === "format-not-enabled") return { status: "WARN", detail: `${repo} hasn't enabled ${diff.ext} in .forge/formats` };
  if (!Array.isArray(diff.changes)) return { problems: [`diff of ${at} has no changes list`] };

  const raw = await request(`/repos/${repo}/rawblob?path=${enc(found.path)}&sha=${found.sha}`, { method: "HEAD", accept: "*/*" });
  const size = Number(raw.headers.get("content-length"));
  if (raw.status !== 200 || isHtml(raw) || !(size > 0)) {
    return { problems: [`raw ${at} answered ${raw.status} ${type(raw)}, ${raw.headers.get("content-length") ?? "no"} bytes`] };
  }
  return { detail: `${at}: ${diff.format} diff, ${(size / 1024).toFixed(0)} KB model` };
});

// ── Uploads: nothing in front of the API caps their size ─────────────────────
await check("Uploads", async () => {
  const where = repo ?? "nobody/nothing";
  const problems = [];
  const probes = [
    // A commit from the web: the API turns it away for want of sign-in, once it has it all.
    [`/repos/${where}/contents`, "application/json", JSON.stringify({ pad: "x".repeat(UPLOAD_BYTES) })],
    // A push: git's own route, turned away the same way.
    [`/git/${where}.git/git-receive-pack`, "application/x-git-receive-pack-request", Buffer.alloc(UPLOAD_BYTES)],
  ];
  for (const [path, contentType, body] of probes) {
    const res = await request(path, { method: "POST", headers: { "content-type": contentType }, body });
    const text = await res.text();
    if (res.status === 413) problems.push(`${path} refused 8 MB: ${isHtml(res) ? "a proxy's limit" : text.slice(0, 120)}`);
    else if (res.status >= 500 || isHtml(res)) problems.push(`${path} answered ${res.status} ${type(res)}`);
  }
  return { problems, detail: "8 MB reaches the API and git" };
});

// ── SSH: reachable, and showing the fingerprint users will meet ──────────────
await check("SSH", async () => {
  if (!info) return { problems: ["no /server/info to read the SSH settings from"] };
  if (!info.sshEnabled) return { status: "SKIP", detail: "SSH is off on this server" };
  const host = info.sshHost ?? base.hostname;
  const port = info.sshPort;
  const banner = await new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: 10_000 });
    socket.once("data", (chunk) => { socket.destroy(); resolve(chunk.toString("latin1").split("\r\n")[0]); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`no answer from ${host}:${port}`)); });
    socket.once("error", (err) => reject(new Error(`${host}:${port}: ${err.code ?? err.message}`)));
  });
  if (!banner.startsWith("SSH-")) return { problems: [`${host}:${port} isn't SSH: ${banner.slice(0, 60)}`] };

  const advertised = (info.sshFingerprints?.map((f) => f.fingerprint) ?? [info.sshFingerprint]).filter(Boolean);
  if (!advertised.length) return { status: "WARN", detail: `${host}:${port} answers, but the site shows no fingerprint to check it against` };
  let presented;
  try {
    const scan = execFileSync("ssh-keyscan", ["-T", "10", "-p", String(port), host], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    presented = execFileSync("ssh-keygen", ["-lf", "-"], { input: scan, encoding: "utf8" }).match(/SHA256:[A-Za-z0-9+/=]+/g) ?? [];
  } catch {
    return { status: "WARN", detail: `${host}:${port} answers; install ssh-keyscan to compare fingerprints` };
  }
  const wrong = advertised.filter((fp) => !presented.includes(fp));
  if (wrong.length) {
    return { problems: [`the site shows ${wrong.join(", ")}, but ${host}:${port} presents ${presented.join(", ") || "no keys"}`] };
  }
  return { detail: `${host}:${port} presents the ${advertised.length === 1 ? "fingerprint" : "fingerprints"} the site shows` };
});

// ── Report ───────────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const paint = { PASS: "32", FAIL: "31", WARN: "33", SKIP: "90" };
const label = (s) => (tty ? `\x1b[${paint[s]}m${s.padEnd(4)}\x1b[0m` : s.padEnd(4));
console.log(`ForgeHub at ${base.origin}${repo ? `, reading ${repo}` : ""}\n`);
for (const r of results) {
  const [first, ...rest] = r.detail;
  console.log(`  ${label(r.status)}  ${r.name.padEnd(10)} ${first}`);
  for (const line of rest) console.log(`  ${" ".repeat(4)}  ${" ".repeat(10)} ${line}`);
}
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${failed ? `${failed} of ${results.length} checks failed.` : `All ${results.length} checks passed${results.some((r) => r.status === "WARN") ? ", with warnings" : ""}.`}`);
process.exit(failed ? 1 : 0);
