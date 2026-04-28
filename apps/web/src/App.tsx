import { useState } from "react";
import { LoginPage } from "./pages/LoginPage";
import { RepoListPage } from "./pages/RepoListPage";
import { SnapshotPage } from "./pages/SnapshotPage";
import type { Repo, User } from "./types";

type View =
  | { name: "login" }
  | { name: "repos" }
  | { name: "snapshot"; repo: Repo };

export function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("fh_token"));
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem("fh_user");
    return raw ? (JSON.parse(raw) as User) : null;
  });
  const [view, setView] = useState<View>(token && user ? { name: "repos" } : { name: "login" });

  function handleAuth(t: string, u: User) {
    localStorage.setItem("fh_token", t);
    localStorage.setItem("fh_user", JSON.stringify(u));
    setToken(t);
    setUser(u);
    setView({ name: "repos" });
  }

  function handleLogout() {
    localStorage.removeItem("fh_token");
    localStorage.removeItem("fh_user");
    setToken(null);
    setUser(null);
    setView({ name: "login" });
  }

  if (view.name === "login" || !token || !user) {
    return <LoginPage onAuth={handleAuth} />;
  }

  if (view.name === "repos") {
    return (
      <RepoListPage
        token={token}
        user={user}
        onSelectRepo={(repo) => setView({ name: "snapshot", repo })}
        onLogout={handleLogout}
      />
    );
  }

  if (view.name === "snapshot") {
    return (
      <SnapshotPage
        token={token}
        user={user}
        repo={view.repo}
        onBack={() => setView({ name: "repos" })}
      />
    );
  }

  return null;
}
