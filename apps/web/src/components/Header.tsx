import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { listNotifications } from "../api";
import { ForgeLogo } from "./ForgeLogo";
import type { User } from "../types";

type Props = {
  user: User;
  onLogout: () => void;
  token?: string;
};

const PlusDropIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path fillRule="evenodd" d="M7.75 2a.75.75 0 01.75.75V7h4.25a.75.75 0 110 1.5H8.5v4.25a.75.75 0 11-1.5 0V8.5H2.75a.75.75 0 010-1.5H7V2.75A.75.75 0 017.75 2z" />
    <path fillRule="evenodd" d="M4.427 9.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 9H4.604a.25.25 0 00-.177.427z" transform="translate(0,-6)" />
  </svg>
);

const ChevronDown = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.7 }}>
    <path fillRule="evenodd" d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
  </svg>
);

const BellIcon = ({ count }: { count: number }) => (
  <span className="relative inline-flex items-center">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 16a2 2 0 001.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 008 16z" />
      <path fillRule="evenodd" d="M8 1.5A3.5 3.5 0 004.5 5v2.947c0 .346-.102.683-.294.97l-1.703 2.556a.018.018 0 00-.003.01l.001.006c0 .01.004.02.01.03a.265.265 0 00.189.097l.013.001h10.582l.013-.001a.265.265 0 00.189-.097.051.051 0 00.01-.03l.001-.006a.018.018 0 00-.003-.01l-1.703-2.557a1.75 1.75 0 01-.294-.97V5A3.5 3.5 0 008 1.5zM3 5a5 5 0 0110 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.518 1.518 0 0113.482 13H2.518a1.518 1.518 0 01-1.263-2.359l1.703-2.555A.25.25 0 003 7.947V5z" />
    </svg>
    {count > 0 && (
      <span className="absolute -top-1 -right-1.5 flex items-center justify-center h-3.5 min-w-[14px] px-0.5 text-[9px] font-bold bg-gh-accent text-white rounded-full leading-none">
        {count > 9 ? "9+" : count}
      </span>
    )}
  </span>
);

export function Header({ user, onLogout, token }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (!token) return;
    listNotifications(token, false)
      .then((d) => setUnreadCount(d.notifications.length))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    setSearchQuery(searchParams.get("q") ?? "");
  }, [searchParams]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    navigate(`/search?q=${encodeURIComponent(q)}&type=repos`);
  }

  const initial = (user.displayName || user.handle)[0].toUpperCase();

  return (
    <header
      className="flex items-center gap-3 px-4 h-14 relative z-50"
      style={{ backgroundColor: "#1c1917" }}
    >
      {/* Logo */}
      <Link
        to="/"
        className="flex items-center text-white hover:opacity-75 transition-opacity flex-shrink-0"
        style={{ textDecoration: "none" }}
      >
        <ForgeLogo size={28} />
      </Link>

      {/* Breadcrumb / nav — hidden on small screens */}
      <nav className="hidden md:flex items-center gap-1 ml-2">
        <Link
          to={`/${user.handle}`}
          className="text-sm font-semibold px-2 py-1 rounded-md transition-colors"
          style={{ color: "rgba(250,250,249,0.9)", textDecoration: "none" }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.1)")}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = "")}
        >
          {user.handle}
        </Link>
      </nav>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex-1 max-w-sm mx-4 hidden md:block">
        <div className="relative">
          <svg
            width="14" height="14" viewBox="0 0 16 16" fill="currentColor"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "rgba(250,250,249,0.5)" }}
          >
            <path fillRule="evenodd" d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06L10.68 11.74z" />
          </svg>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search…"
            className="w-full pl-8 pr-3 py-1 text-sm rounded-md border outline-none transition-colors"
            style={{
              backgroundColor: "rgba(255,255,255,0.08)",
              borderColor: "rgba(250,250,249,0.2)",
              color: "rgba(250,250,249,0.9)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.backgroundColor = "#ffffff";
              e.currentTarget.style.color = "#1c1917";
              e.currentTarget.style.borderColor = "#ea580c";
            }}
            onBlur={(e) => {
              if (!e.currentTarget.value) {
                e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)";
                e.currentTarget.style.color = "rgba(250,250,249,0.9)";
                e.currentTarget.style.borderColor = "rgba(250,250,249,0.2)";
              }
            }}
          />
        </div>
      </form>

      {/* Actions */}
      <div className="flex items-center gap-1">
        {/* New button */}
        <button
          className="flex items-center gap-1 px-2 py-1 rounded-md text-sm transition-colors flex-shrink-0"
          style={{ color: "rgba(250,250,249,0.75)" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(255,255,255,0.1)"; (e.currentTarget as HTMLElement).style.color = "rgba(250,250,249,1)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ""; (e.currentTarget as HTMLElement).style.color = "rgba(250,250,249,0.75)"; }}
          onClick={() => navigate("/")}
          title="Create new…"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path fillRule="evenodd" d="M7.75 2a.75.75 0 01.75.75V7h4.25a.75.75 0 110 1.5H8.5v4.25a.75.75 0 11-1.5 0V8.5H2.75a.75.75 0 010-1.5H7V2.75A.75.75 0 017.75 2z" />
          </svg>
          <ChevronDown />
        </button>

        {/* Notifications */}
        <Link
          to="/notifications"
          className="flex items-center px-2 py-1 rounded-md transition-colors"
          style={{ color: "rgba(250,250,249,0.75)", textDecoration: "none" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(255,255,255,0.1)"; (e.currentTarget as HTMLElement).style.color = "rgba(250,250,249,1)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ""; (e.currentTarget as HTMLElement).style.color = "rgba(250,250,249,0.75)"; }}
          title="Notifications"
        >
          <BellIcon count={unreadCount} />
        </Link>

        {/* Avatar / user menu */}
        <div className="relative ml-1" ref={menuRef}>
          <button
            className="flex items-center gap-1 rounded-full transition-opacity hover:opacity-80 cursor-pointer p-0 border-none bg-transparent"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="User menu"
          >
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
              style={{ backgroundColor: "#ea580c" }}
            >
              {initial}
            </div>
          </button>

          {menuOpen && (
            <div
              className="absolute right-0 top-[calc(100%+8px)] w-56 rounded-lg shadow-xl z-50 py-1 text-sm overflow-hidden"
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e7e5e4",
                boxShadow: "0 8px 24px rgba(120,113,108,0.2)",
              }}
            >
              {/* User info */}
              <div className="px-4 py-3 border-b" style={{ borderColor: "#f5f5f4" }}>
                <Link to={`/${user.handle}`} className="no-underline" onClick={() => setMenuOpen(false)}>
                  <p className="font-semibold text-gh-text text-sm hover:text-gh-accent">{user.displayName || user.handle}</p>
                  <p className="text-xs text-gh-muted mt-0.5">@{user.handle}</p>
                </Link>
              </div>

              <div className="py-1">
                <Link
                  to="/"
                  className="flex items-center px-4 py-1.5 text-sm text-gh-text hover:bg-gh-accent hover:text-white no-underline"
                  onClick={() => setMenuOpen(false)}
                >
                  Your repositories
                </Link>
                <Link
                  to="/notifications"
                  className="flex items-center px-4 py-1.5 text-sm text-gh-text hover:bg-gh-accent hover:text-white no-underline"
                  onClick={() => setMenuOpen(false)}
                >
                  Notifications
                  {unreadCount > 0 && (
                    <span className="ml-auto counter">{unreadCount}</span>
                  )}
                </Link>
                <Link
                  to="/settings/tokens"
                  className="flex items-center px-4 py-1.5 text-sm text-gh-text hover:bg-gh-accent hover:text-white no-underline"
                  onClick={() => setMenuOpen(false)}
                >
                  Developer settings
                </Link>
              </div>

              <div className="border-t py-1" style={{ borderColor: "#f5f5f4" }}>
                <button
                  className="w-full text-left px-4 py-1.5 text-sm text-gh-text hover:bg-gh-accent hover:text-white bg-transparent border-none cursor-pointer"
                  onClick={() => { setMenuOpen(false); onLogout(); }}
                >
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
