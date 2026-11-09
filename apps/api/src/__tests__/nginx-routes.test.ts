/**
 * The deployed site serves the app and the API from one origin, and nginx
 * decides which gets a path. Every API route has to be on its list, and every
 * page whose path the API also claims has to be on its list of pages, or the
 * deployed site breaks where development (two origins) doesn't.
 */
import { vi, describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routes = vi.hoisted(() => [] as string[]);
vi.mock("fastify", async (orig) => {
  const mod = await orig<typeof import("fastify")>();
  const fastify = ((...args: Parameters<typeof mod.default>) => {
    const app = mod.default(...args);
    app.addHook("onRoute", (route) => void routes.push(route.url));
    return app;
  }) as typeof mod.default;
  return { ...mod, default: fastify };
});

import { createTestServer } from "./helpers/server.js";

const repoFile = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");
const CONFIGS = ["docker/nginx.conf", "apps/web/nginx.conf"];
// /git/ has a location of its own; the API's built-in dev page isn't part of the site.
const OWN_LOCATION = new Set(["git", "ui"]);

function rules(config: string) {
  const apiList = /location ~ \^\/\(([^)]+)\)\(\/\|\$\) \{/.exec(config)?.[1];
  const pages = /location ~ (\^\/\(notifications.*\)\$) \{/.exec(config)?.[1];
  if (!apiList || !pages) throw new Error("nginx config without the API and page locations");
  return { api: new Set(apiList.split("|")), pages: new RegExp(pages) };
}

beforeAll(async () => {
  const app = await createTestServer();
  await app.ready();
  await app.close();
});

describe.each(CONFIGS)("%s", (file) => {
  const { api, pages } = rules(repoFile(file));

  it("sends every API route to the API", () => {
    const prefixes = new Set(routes.map((url) => url.split("/")[1]).filter((p) => p && !OWN_LOCATION.has(p)));
    expect(prefixes.size).toBeGreaterThan(10);
    expect([...prefixes].filter((p) => !api.has(p))).toEqual([]);
  });

  it("gives a browser the app on pages whose path the API also has", () => {
    const appPaths = [...repoFile("apps/web/src/App.tsx").matchAll(/path="(\/[^"*]*)"/g)].map((m) => m[1]);
    const shared = appPaths.filter((path) => api.has(path.split("/")[1])).map((path) => path.replace(/:\w+/g, "x"));
    expect(shared).toContain("/notifications");
    expect(shared.filter((path) => !pages.test(path))).toEqual([]);
  });
});
