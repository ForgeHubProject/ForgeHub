#!/usr/bin/env node
/**
 * dev-shot.mjs — capture ForgeHub screens with Playwright for design review.
 *
 * Logs in as the dev-seed user (demo@forgehub.dev), then captures each route at
 * 1440×900 (desktop) and 375×812 (mobile) in both light and dark themes.
 *
 * Usage:
 *   node scripts/dev-shot.mjs
 *   WEB_URL=http://localhost:5100 API_URL=http://localhost:3100 \
 *     ROUTES="/,/demo/aurora-ui,/demo/aurora-ui/issues" SHOT_DIR=./shots \
 *     node scripts/dev-shot.mjs
 *
 * Uses the system Chromium at /opt/pw-browsers/chromium — NEVER runs
 * `playwright install`. Playwright is resolved from the local devDependency or
 * the global install, whichever is present.
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const paths = [process.cwd()];
  try {
    paths.push(execSync("npm root -g").toString().trim());
  } catch {
    /* ignore */
  }
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    try {
      return require(require.resolve(name, { paths }));
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "Playwright not found. It is a devDependency of @forgehub/web, and also " +
      "available globally. Do NOT run `playwright install` — the browser lives " +
      "at /opt/pw-browsers/chromium.",
  );
}

const WEB_URL = (process.env.WEB_URL || "http://localhost:5100").replace(/\/$/, "");
const API_URL = (process.env.API_URL || "http://localhost:3100").replace(/\/$/, "");
const EXECUTABLE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const SHOT_DIR = resolve(process.env.SHOT_DIR || "./shots");

const DEMO = { email: "demo@forgehub.dev", password: "forgehub-demo" };

const ROUTES = (process.env.ROUTES ||
  "/login,/,/demo/aurora-ui,/demo/aurora-ui/issues,/notifications")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "375x812", width: 375, height: 812 },
];
const THEMES = ["light", "dark"];

const slug = (r) => (r === "/" ? "home" : r.replace(/^\//, "").replace(/\//g, "-")) || "root";

async function login() {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(DEMO),
  });
  if (!res.ok) {
    throw new Error(`Could not log in as ${DEMO.email} (${res.status}). Run scripts/dev-seed.mjs first.`);
  }
  return res.json(); // { token, user }
}

async function main() {
  const { chromium } = loadPlaywright();
  mkdirSync(SHOT_DIR, { recursive: true });

  const { token, user } = await login();
  console.log(`\nCapturing ${ROUTES.length} routes × ${VIEWPORTS.length} viewports × ${THEMES.length} themes → ${SHOT_DIR}\n`);

  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  let count = 0;
  try {
    for (const vp of VIEWPORTS) {
      for (const theme of THEMES) {
        for (const route of ROUTES) {
          const authed = route !== "/login";
          const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 2,
          });
          // Seed localStorage before any app script runs: theme + (maybe) auth.
          await context.addInitScript(
            ([t, u, th, isAuthed]) => {
              localStorage.setItem("fh_theme", th);
              if (isAuthed) {
                localStorage.setItem("fh_token", t);
                localStorage.setItem("fh_user", u);
              } else {
                localStorage.removeItem("fh_token");
                localStorage.removeItem("fh_user");
              }
            },
            [token, JSON.stringify(user), theme, authed],
          );

          const page = await context.newPage();
          await page.goto(`${WEB_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
          await page.waitForTimeout(400); // settle animations/fonts

          const file = `${SHOT_DIR}/${slug(route)}__${vp.name}__${theme}.png`;
          await page.screenshot({ path: file, fullPage: true });
          count++;
          console.log(`  ✓ ${slug(route).padEnd(24)} ${vp.name.padEnd(9)} ${theme}`);
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\nDone — ${count} screenshots in ${SHOT_DIR}\n`);
}

main().catch((err) => {
  console.error("\nScreenshot run failed:", err.message);
  process.exit(1);
});
