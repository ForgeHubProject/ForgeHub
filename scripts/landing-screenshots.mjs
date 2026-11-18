#!/usr/bin/env node
/**
 * landing-screenshots.mjs — retake the landing page's product shots
 * (apps/web/src/assets/landing/*.webp) from a running ForgeHub.
 *
 * They come from the Lanternfall demo (demo-sandbox/gamedev): pull request #1,
 * "Keeper: hooded cloak, lantern raised", which changes the keeper's model and
 * its concept PSD. Each shot is taken in the light and the dark theme:
 *
 *   diff-3d   the 3D view of keeper.glb's change (the hero)
 *   pulls     the repository's pull requests
 *   psd       the concept PSD, side by side
 *
 * Usage:
 *   FH_LOGIN=copy-tester FH_PASSWORD=… WEB_URL=http://localhost:5174 API_URL=http://localhost:3002 \
 *     LANDING_REPO=copy-tester/lanternfall node scripts/landing-screenshots.mjs
 *
 * Needs ImageMagick (`magick`) for the WebP conversion, and a Chromium with
 * WebGL (SwiftShader is enough). Uses the system Chromium; never runs
 * `playwright install`.
 */
import { createRequire } from "node:module";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const paths = [process.cwd(), resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web")];
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
  throw new Error("Playwright not found. It is a devDependency of @forgehub/web.");
}

const WEB_URL = (process.env.WEB_URL || "http://localhost:5173").replace(/\/$/, "");
const API_URL = (process.env.API_URL || "http://localhost:3001").replace(/\/$/, "");
const EXECUTABLE = process.env.PW_CHROMIUM || "/usr/bin/chromium";
const REPO = process.env.LANDING_REPO || "gamedev/lanternfall";
const PR = process.env.LANDING_PR || "1";
const MODEL = "assets/models/characters/keeper.glb";
const PSD = "art/concept/keeper_concept.psd";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web/src/assets/landing");

async function login() {
  const email = process.env.FH_LOGIN;
  const password = process.env.FH_PASSWORD;
  if (!email || !password) throw new Error("Set FH_LOGIN and FH_PASSWORD to an account that can read the repository.");
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Could not sign in (${res.status}).`);
  return res.json(); // { token, user }
}

/** Mark the Files changed card whose header names `file`, and scroll to it. */
async function markCard(page, file) {
  await page.evaluate((name) => {
    const label = [...document.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && e.textContent?.trim() === name).pop();
    let card = label;
    while (card && !card.className?.includes?.("scroll-mt-16")) card = card.parentElement;
    if (!card) throw new Error(`No diff card for ${name}`);
    card.setAttribute("data-shot", "card");
    card.scrollIntoView({ block: "start" });
  }, file);
  await page.waitForTimeout(1500);
}

const SHOTS = {
  "diff-3d": {
    viewport: { width: 1280, height: 900 },
    width: 1600,
    async take(page, path) {
      await page.goto(`${WEB_URL}/${REPO}/pulls/${PR}/files`, { waitUntil: "networkidle" });
      await markCard(page, MODEL);
      await page.locator('[data-shot="card"]').getByRole("button", { name: "View in 3D" }).click();
      await page.waitForTimeout(12_000);
      await page.evaluate(() => {
        let view = document.querySelector('[data-shot="card"] canvas');
        while (view && !(view.textContent.includes("Structure") && view.textContent.includes("Changes") && view.getBoundingClientRect().width > 800)) {
          view = view.parentElement;
        }
        view.setAttribute("data-shot", "viewer");
        view.scrollIntoView({ block: "center" });
      });
      await page.waitForTimeout(2000);
      await page.locator('[data-shot="viewer"]').screenshot({ path });
    },
  },
  pulls: {
    viewport: { width: 1280, height: 960 },
    width: 1200,
    async take(page, path) {
      await page.goto(`${WEB_URL}/${REPO}/pulls`, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);
      await page.screenshot({ path });
    },
  },
  psd: {
    viewport: { width: 1280, height: 900 },
    width: 1200,
    // The card is a little taller than 4:3; the cut is empty frame at the bottom.
    crop: { aspect: 4 / 3 },
    async take(page, path) {
      await page.goto(`${WEB_URL}/${REPO}/pulls/${PR}/files`, { waitUntil: "networkidle" });
      await markCard(page, PSD);
      await page.locator('[data-shot="card"] button', { hasText: "Side by side" }).first().click();
      await page.waitForTimeout(4000);
      const fits = page.locator('[data-shot="card"] button', { hasText: /^Fit$/ });
      for (let i = 0; i < (await fits.count()); i++) await fits.nth(i).click();
      await page.waitForTimeout(3000);
      await page.locator('[data-shot="card"]').screenshot({ path });
    },
  },
};

async function main() {
  const { chromium } = loadPlaywright();
  const { token, user } = await login();
  const tmp = mkdtempSync(join(tmpdir(), "fh-landing-"));
  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  try {
    for (const [name, shot] of Object.entries(SHOTS)) {
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2, colorScheme: theme });
        await context.addInitScript(
          ([t, u, th]) => {
            localStorage.setItem("fh_theme", th);
            localStorage.setItem("fh_token", t);
            localStorage.setItem("fh_user", u);
          },
          [token, JSON.stringify(user), theme],
        );
        const page = await context.newPage();
        const png = join(tmp, `${name}-${theme}.png`);
        await shot.take(page, png);
        await context.close();

        const args = [png];
        if (shot.crop) {
          const [w, h] = execFileSync("magick", ["identify", "-format", "%w %h", png]).toString().split(" ").map(Number);
          args.push("-crop", `${w}x${Math.min(h, Math.round(w / shot.crop.aspect))}+0+0`, "+repage");
        }
        args.push("-resize", `${shot.width}x`, "-quality", "82", join(OUT, `${name}-${theme}.webp`));
        execFileSync("magick", args);
        console.log(`  ✓ ${name} ${theme}`);
      }
    }
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\nDone: ${OUT}\nIf a shot's size changed, update its width/height in apps/web/src/pages/LandingPage.tsx.\n`);
}

main().catch((err) => {
  console.error("\nScreenshot run failed:", err.message);
  process.exit(1);
});
