import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { ApiError, getPublicProfile } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { NewOrgPage } from "./pages/NewOrgPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { OrgProfilePage } from "./pages/OrgProfilePage";
import { OrgSettingsPage } from "./pages/OrgSettingsPage";
import { RepoListPage } from "./pages/RepoListPage";
import { RepoPage } from "./pages/RepoPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsTokensPage } from "./pages/SettingsTokensPage";
import { SettingsSSHKeysPage } from "./pages/SettingsSSHKeysPage";
import { SettingsSessionsPage } from "./pages/SettingsSessionsPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { DEFAULT_TITLE } from "./pages/useDocumentTitle";
import type { User } from "./types";

/**
 * `/:handle` is shared by users and orgs (issue #114): the handle space is
 * unified. Probe the user endpoint first — a 404 means the handle belongs to an
 * org, so render the org profile instead. Each concrete page fetches its own data
 * (and renders its own not-found), so this only needs to pick which to mount.
 */
function ProfileRoute({ token, user, onLogout, onUserChange }: { token: string; user: User; onLogout: () => void; onUserChange: (u: User) => void }) {
  const { handle } = useParams<{ handle: string }>();
  const [kind, setKind] = useState<"loading" | "user" | "org">("loading");

  useEffect(() => {
    if (!handle) return;
    let active = true;
    setKind("loading");
    getPublicProfile(token, handle)
      .then(() => active && setKind("user"))
      .catch((e) => {
        if (!active) return;
        setKind(e instanceof ApiError && e.status === 404 ? "org" : "user");
      });
    return () => {
      active = false;
    };
  }, [token, handle]);

  if (kind === "loading") return <div className="min-h-screen bg-fh-canvas" />;
  if (kind === "org") return <OrgProfilePage token={token} user={user} onLogout={onLogout} />;
  return <UserProfilePage token={token} user={user} onLogout={onLogout} onUserChange={onUserChange} />;
}

/**
 * Seeds the app-level default document title on first paint. Rendered before
 * the route tree so a page that claims its own title via `useDocumentTitle`
 * (its effect runs after this one) still wins, while any route that sets no
 * title falls back to `DEFAULT_TITLE`.
 */
function DefaultTitle() {
  useEffect(() => {
    document.title = DEFAULT_TITLE;
  }, []);
  return null;
}

function AppRoutes() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("fh_token"));
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem("fh_user");
    return raw ? (JSON.parse(raw) as User) : null;
  });
  const navigate = useNavigate();

  function handleAuth(t: string, u: User) {
    localStorage.setItem("fh_token", t);
    localStorage.setItem("fh_user", JSON.stringify(u));
    setToken(t);
    setUser(u);
    navigate("/");
  }

  function handleLogout() {
    localStorage.removeItem("fh_token");
    localStorage.removeItem("fh_user");
    setToken(null);
    setUser(null);
    navigate("/login");
  }

  function handleUserChange(u: User) {
    localStorage.setItem("fh_user", JSON.stringify(u));
    setUser(u);
  }

  const authed = !!token && !!user;

  return (
    <>
      <DefaultTitle />
      <Routes>
      <Route
        path="/login"
        element={authed ? <Navigate to="/" replace /> : <LoginPage onAuth={handleAuth} />}
      />
      <Route
        path="/"
        element={
          authed ? (
            <RepoListPage
              token={token!}
              user={user!}
              onSelectRepo={(repo) =>
                navigate(`/${repo.ownerHandle ?? user!.handle}/${repo.name}`)
              }
              onLogout={handleLogout}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/notifications"
        element={
          authed ? (
            <NotificationsPage token={token!} user={user!} onLogout={handleLogout} onUserChange={handleUserChange} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/search"
        element={
          authed ? (
            <SearchPage token={token!} user={user!} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/settings/tokens"
        element={
          authed ? (
            <SettingsTokensPage token={token!} user={user!} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/settings/keys"
        element={
          authed ? (
            <SettingsSSHKeysPage token={token!} user={user!} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/settings/sessions"
        element={
          authed ? (
            <SettingsSessionsPage token={token!} user={user!} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/organizations/new"
        element={
          authed ? (
            <NewOrgPage token={token!} user={user!} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/orgs/:handle/settings"
        element={
          authed ? (
            <OrgSettingsPage token={token!} user={user!} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/:handle/:repoName/*"
        element={
          authed ? (
            <RepoPage token={token!} user={user!} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/:handle"
        element={
          authed ? (
            <ProfileRoute token={token!} user={user!} onLogout={handleLogout} onUserChange={handleUserChange} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
