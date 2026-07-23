import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { RepoListPage } from "./pages/RepoListPage";
import { RepoPage } from "./pages/RepoPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsTokensPage } from "./pages/SettingsTokensPage";
import { SettingsSSHKeysPage } from "./pages/SettingsSSHKeysPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { DEFAULT_TITLE } from "./pages/useDocumentTitle";
import type { User } from "./types";

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
            <UserProfilePage token={token!} user={user!} onLogout={handleLogout} />
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
