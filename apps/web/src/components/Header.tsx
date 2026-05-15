import { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { User } from "../types";

type Props = {
  user: User;
  onLogout: () => void;
};

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 16a2 2 0 001.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 008 16z" />
      <path fillRule="evenodd" d="M8 1.5A3.5 3.5 0 004.5 5v2.947c0 .346-.102.683-.294.97l-1.703 2.556a.018.018 0 00-.003.01l.001.006c0 .01.004.02.01.03a.265.265 0 00.189.097l.013.001h10.582l.013-.001a.265.265 0 00.189-.097.051.051 0 00.01-.03l.001-.006a.018.018 0 00-.003-.01l-1.703-2.557a1.75 1.75 0 01-.294-.97V5A3.5 3.5 0 008 1.5zM3 5a5 5 0 0110 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.518 1.518 0 0113.482 13H2.518a1.518 1.518 0 01-1.263-2.359l1.703-2.555A.25.25 0 003 7.947V5z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M7.75 2a.75.75 0 01.75.75V7h4.25a.75.75 0 110 1.5H8.5v4.25a.75.75 0 11-1.5 0V8.5H2.75a.75.75 0 010-1.5H7V2.75A.75.75 0 017.75 2z" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
    </svg>
  );
}

export function Header({ user, onLogout }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const initial = (user.displayName || user.handle)[0].toUpperCase();

  return (
    <header className="bg-gh-header text-gh-header-text h-[60px] flex items-center px-4 gap-4 z-50 relative">
      {/* Logo */}
      <Link to="/" className="flex items-center text-gh-header-text hover:text-white no-underline flex-shrink-0">
        <svg height="32" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
            0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
            -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
            .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
            -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
            .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
            .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
            0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        <span className="ml-2 font-semibold text-sm hidden sm:inline">ForgeHub</span>
      </Link>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side actions */}
      <div className="flex items-center gap-2">
        {/* Create new */}
        <button
          className="flex items-center gap-1 text-gh-header-muted hover:text-white text-sm px-2 py-1 rounded-md hover:bg-white/10 transition-colors"
          onClick={() => navigate("/")}
          title="Create new"
        >
          <PlusIcon />
          <ChevronDown />
        </button>

        {/* Notifications */}
        <Link
          to="/notifications"
          className="text-gh-header-muted hover:text-white px-2 py-1 rounded-md hover:bg-white/10 transition-colors no-underline"
          title="Notifications"
        >
          <BellIcon />
        </Link>

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            className="flex items-center gap-1 rounded-full hover:opacity-80 transition-opacity"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Open user menu"
          >
            <div className="avatar w-8 h-8 flex items-center justify-center bg-gh-accent text-white text-xs font-semibold">
              {initial}
            </div>
            <ChevronDown />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-52 bg-gh-canvas border border-gh-border rounded-md shadow-lg z-50 py-1 text-gh-text">
              <div className="px-4 py-2 border-b border-gh-border">
                <p className="text-gh-sm font-semibold">{user.displayName || user.handle}</p>
                <p className="text-gh-xs text-gh-muted">@{user.handle}</p>
              </div>

              <div className="py-1">
                <Link
                  to="/"
                  className="block px-4 py-1.5 text-gh-sm text-gh-text hover:bg-gh-accent hover:text-white no-underline"
                  onClick={() => setMenuOpen(false)}
                >
                  Your repositories
                </Link>
                <Link
                  to="/notifications"
                  className="block px-4 py-1.5 text-gh-sm text-gh-text hover:bg-gh-accent hover:text-white no-underline"
                  onClick={() => setMenuOpen(false)}
                >
                  Notifications
                </Link>
              </div>

              <div className="border-t border-gh-border py-1">
                <button
                  className="w-full text-left px-4 py-1.5 text-gh-sm text-gh-text hover:bg-gh-accent hover:text-white bg-transparent border-none cursor-pointer"
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
