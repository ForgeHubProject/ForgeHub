import type { FastifyInstance } from "fastify";

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ForgeHub Dev UI</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; max-width: 980px; }
    h1, h2 { margin-bottom: 8px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    input, select, button, textarea { padding: 8px; font-size: 14px; }
    input, select { min-width: 200px; }
    section { border: 1px solid #ddd; border-radius: 8px; padding: 14px; margin-bottom: 14px; }
    code { background: #f5f5f5; padding: 2px 4px; border-radius: 4px; }
    #token { width: 100%; }
    #out { background: #111; color: #c9f7c9; padding: 12px; border-radius: 8px; min-height: 180px; white-space: pre-wrap; overflow: auto; }
    small { color: #666; }
  </style>
</head>
<body>
  <h1>ForgeHub Dev UI</h1>
  <small>Minimal browser test page for auth + repo + storage endpoints.</small>

  <section>
    <h2>Auth</h2>
    <div class="row">
      <input id="email" placeholder="email" />
      <input id="password" placeholder="password" type="password" value="password12" />
      <input id="handle" placeholder="handle" />
      <button id="registerBtn">Register</button>
      <button id="loginBtn">Login</button>
      <button id="meBtn">Who am I?</button>
    </div>
    <input id="token" placeholder="JWT token" />
  </section>

  <section>
    <h2>Repos</h2>
    <div class="row">
      <input id="repoName" placeholder="repo name" />
      <select id="visibility">
        <option value="private">private</option>
        <option value="public">public</option>
      </select>
      <input id="repoDesc" placeholder="description (optional)" />
      <button id="createRepoBtn">Create Repo</button>
      <button id="mineBtn">List My Repos</button>
    </div>

    <div class="row">
      <input id="lookupHandle" placeholder="lookup handle" />
      <input id="lookupRepo" placeholder="lookup repo" />
      <button id="getRepoBtn">Get Repo</button>
      <button id="userReposBtn">Get User Repos</button>
      <button id="storageBtn">Storage Debug</button>
      <button id="deleteRepoBtn">Delete Repo</button>
    </div>
  </section>

  <section>
    <h2>Output</h2>
    <div id="out">Ready.</div>
  </section>

  <script>
    const out = document.getElementById("out");
    const tokenEl = document.getElementById("token");

    function jsonOrText(res, txt) {
      try { return JSON.parse(txt); } catch { return txt; }
    }

    async function call(method, path, body, useAuth = false) {
      const headers = { "Content-Type": "application/json" };
      if (useAuth && tokenEl.value.trim()) {
        headers["Authorization"] = "Bearer " + tokenEl.value.trim();
      }
      const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const txt = await res.text();
      const parsed = jsonOrText(res, txt);
      out.textContent = method + " " + path + "\\nstatus: " + res.status + "\\n\\n" + JSON.stringify(parsed, null, 2);
      return { status: res.status, data: parsed };
    }

    document.getElementById("registerBtn").onclick = async () => {
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      const handle = document.getElementById("handle").value.trim();
      const r = await call("POST", "/auth/register", { email, password, handle });
      if (r.data && r.data.token) tokenEl.value = r.data.token;
    };

    document.getElementById("loginBtn").onclick = async () => {
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      const r = await call("POST", "/auth/login", { email, password });
      if (r.data && r.data.token) tokenEl.value = r.data.token;
    };

    document.getElementById("meBtn").onclick = async () => call("GET", "/auth/me", undefined, true);

    document.getElementById("createRepoBtn").onclick = async () => {
      const name = document.getElementById("repoName").value.trim();
      const visibility = document.getElementById("visibility").value;
      const description = document.getElementById("repoDesc").value.trim();
      const body = description ? { name, visibility, description } : { name, visibility };
      await call("POST", "/repos", body, true);
    };

    document.getElementById("mineBtn").onclick = async () => call("GET", "/repos/mine", undefined, true);

    document.getElementById("getRepoBtn").onclick = async () => {
      const handle = document.getElementById("lookupHandle").value.trim();
      const repo = document.getElementById("lookupRepo").value.trim();
      await call("GET", "/repos/" + encodeURIComponent(handle) + "/" + encodeURIComponent(repo), undefined, true);
    };

    document.getElementById("userReposBtn").onclick = async () => {
      const handle = document.getElementById("lookupHandle").value.trim();
      await call("GET", "/users/" + encodeURIComponent(handle) + "/repos", undefined, true);
    };

    document.getElementById("storageBtn").onclick = async () => {
      const handle = document.getElementById("lookupHandle").value.trim();
      const repo = document.getElementById("lookupRepo").value.trim();
      await call(
        "GET",
        "/repos/" + encodeURIComponent(handle) + "/" + encodeURIComponent(repo) + "/storage",
        undefined,
        true
      );
    };

    document.getElementById("deleteRepoBtn").onclick = async () => {
      const repo = document.getElementById("lookupRepo").value.trim();
      await call("DELETE", "/repos/" + encodeURIComponent(repo), undefined, true);
    };
  </script>
</body>
</html>
`;

export async function devUiRoutes(app: FastifyInstance) {
  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(page);
  });
  app.get("/ui", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(page);
  });
}
