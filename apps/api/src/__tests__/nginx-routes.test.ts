/**
 * The deployed site serves the app and the API from one origin, and nginx
 * decides which gets a path. Every API route has to be on its list, and every
 * page whose path the API also claims has to be on its list of pages, or the
 * deployed site breaks where development (two origins) doesn't.
 */
import { vi, describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const routes = vi.hoisted(() => [] as string[]);
vi.mock("fastify", async (orig) => {
  const mod = await orig<typeof import("fastify")>();
  const create = mod.default as unknown as (...args: unknown[]) => FastifyInstance;
  const fastify = (...args: unknown[]) => {
    const app = create(...args);
    app.addHook("onRoute", (route) => void routes.push(route.url));
    return app;
  };
  return { ...mod, default: fastify };
});

import { createTestServer } from "./helpers/server.js";

const repoFile = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");
const CONFIGS = ["docker/nginx.conf", "apps/web/nginx.conf"];
// /git/ and link previews' /_preview/ have locations of their own; the API's
// built-in dev page isn't part of the site.
const OWN_LOCATION = new Set(["git", "_preview", "ui"]);

function rules(config: string) {
  const apiLocation = /location ~ \^\/\(([^)]+)\)\(\/\|\$\) \{([^}]*)\}/.exec(config);
  const pages = /location ~ (\^\/\(notifications.*\)\$) \{/.exec(config)?.[1];
  if (!apiLocation || !pages) throw new Error("nginx config without the API and page locations");
  return { api: new Set(apiLocation[1].split("|")), apiBlock: apiLocation[2], pages: new RegExp(pages) };
}

beforeAll(async () => {
  const app = await createTestServer();
  await app.ready();
  await app.close();
});

describe.each(CONFIGS)("%s", (file) => {
  const { api, apiBlock, pages } = rules(repoFile(file));

  it("leaves upload limits to the API", () => {
    expect(apiBlock).toMatch(/client_max_body_size 0;/);
  });

  it("sends every API route to the API", () => {
    const prefixes = new Set(routes.map((url) => url.split("/")[1]).filter((p) => p && !OWN_LOCATION.has(p)));
    expect(prefixes.size).toBeGreaterThan(10);
    expect([...prefixes].filter((p) => !api.has(p))).toEqual([]);
  });

  it("gives link previews a repository's card, never by an outside request, and leaves files alone", () => {
    const config = repoFile(file);
    expect(config).toMatch(/location \^~ \/_preview\/ \{\s*internal;/);
    expect(config).toMatch(/location \/ \{\s*if \(\$link_preview\) \{\s*rewrite \^ \/_preview\$uri last;/);
    // Which paths a link preview of a page asks about: the map's regexes, in order, first match wins.
    const map = /map "\$link_preview_agent:\$uri" \$link_preview \{([^}]*)\}/.exec(config)?.[1] ?? "";
    const rules = [...map.matchAll(/"~([^"]+)"\s+([01]);/g)].map((m) => [new RegExp(m[1]!), m[2] === "1"] as const);
    const card = (uri: string) => rules.find(([re]) => re.test(`1:${uri}`))?.[1] ?? false;
    expect(["/", "/ada", "/ada/lanternfall", "/ada/my.game/pulls/3"].filter((uri) => !card(uri))).toEqual([]);
    expect(["/favicon.ico", "/assets/index-abc.js", "/robots.txt"].filter(card)).toEqual([]);
    expect(/facebookexternalhit\|[^"]*slackbot[^"]*discordbot[^"]*linkedinbot/.test(config)).toBe(true);
  });

  it("gives a browser the app on pages whose path the API also has", () => {
    const appPaths = [...repoFile("apps/web/src/App.tsx").matchAll(/path="(\/[^"*]*)"/g)].map((m) => m[1]);
    const shared = appPaths.filter((path) => api.has(path.split("/")[1])).map((path) => path.replace(/:\w+/g, "x"));
    expect(shared).toContain("/notifications");
    expect(shared.filter((path) => !pages.test(path))).toEqual([]);
  });
});
