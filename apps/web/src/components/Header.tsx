import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { avatarSrc, listNotifications } from "../api";
import { ForgeLogo } from "./ForgeLogo";
import type { User } from "../types";
import { Avatar } from "../ui/Avatar";
import { DropdownItem, DropdownMenu, DropdownSeparator } from "../ui/DropdownMenu";
import { useTheme } from "../ui/theme";
import { BellIcon, ChevronDownIcon, MoonIcon, SearchIcon, SunIcon } from "../ui/icons";
import { DropdownLabel } from "../ui/DropdownMenu";
import { repoFromPath } from "../lib/shortcuts";

type Props = {
  user: User;
  onLogout: () => void;
  token?: string;
};

/**
 * Global top bar — a dense dark-ink surface in both themes (backed by the
 * theme-independent `fh-header-*` tokens). Holds the brand mark, a global
 * repo search, notifications, and the account menu. Drop-in: same props as
 * before, so every page that renders <Header/> keeps working.
 */
export function Header({ user, onLogout, token }: Props) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { resolved, toggle } = useTheme();
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // Inside a repository, "+" offers its New issue / New pull request (#255).
  const here = repoFromPath(useLocation().pathname);

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

  const displayName = user.displayName || user.handle;

  return (
    <header className="sticky top-0 z-40 flex items-center gap-3 h-14 px-4 bg-fh-header-bg border-b border-fh-header-border">
      {/* Brand */}
      <Link
        to="/"
        aria-label="ForgeHub home"
        className="flex items-center flex-shrink-0 text-fh-header-accent hover:opacity-80 transition-opacity"
      >
        <ForgeLogo size={28} />
      </Link>

      {/* Owner crumb (the feed is a tab on the dashboard, #255) */}
      <nav className="hidden md:flex items-center flex-shrink-0">
        <Link
          to={`/${user.handle}`}
          className="text-fh-sm font-semibold px-2 py-1 rounded-md text-fh-header-text/90 hover:bg-white/10 transition-colors"
        >
          {user.handle}
        </Link>
      </nav>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex-1 max-w-md hidden sm:block">
        <div className="group relative">
          <SearchIcon
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-fh-header-muted"
          />
          <input
            id="global-search"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Type / to search"
            aria-label="Search"
            className="w-full h-8 pl-8 pr-3 text-fh-sm rounded-md border outline-none bg-white/[0.06] border-fh-header-border text-fh-header-text placeholder:text-fh-header-muted transition-colors focus:bg-fh-surface focus:text-fh-fg focus:border-fh-header-accent focus:placeholder:text-fh-fg-placeholder"
          />
        </div>
      </form>

      {/* Actions */}
      <div className="flex items-center gap-0.5 ml-auto sm:ml-0">
        {/* Create something new (#255) */}
        <DropdownMenu
          align="end"
          width={220}
          trigger={
            <button
              type="button"
              aria-label="Create something new"
              title="Create new…"
              className="flex items-center gap-0.5 h-8 px-1.5 rounded-md text-fh-header-text/80 hover:bg-white/10 hover:text-fh-header-text transition-colors cursor-pointer bg-transparent border-none"
            >
              <PlusGlyph />
              <ChevronDownIcon size={12} className="text-fh-header-muted" />
            </button>
          }
        >
          {here && (
            <>
              <DropdownLabel>This repository</DropdownLabel>
              <DropdownItem onSelect={() => navigate(`/${here.owner}/${here.name}/issues/new`)}>New issue</DropdownItem>
              <DropdownItem onSelect={() => navigate(`/${here.owner}/${here.name}/pulls/new`)}>New pull request</DropdownItem>
              <DropdownSeparator />
            </>
          )}
          <DropdownItem onSelect={() => navigate("/?new=repo")}>New repository</DropdownItem>
          <DropdownItem onSelect={() => navigate("/organizations/new")}>New organization</DropdownItem>
        </DropdownMenu>

        {/* Your issues and pull requests, across repositories (#255) */}
        <Link
          to="/issues"
          title="Your issues"
          aria-label="Your issues"
          className="hidden sm:flex items-center justify-center w-8 h-8 rounded-md text-fh-header-text/80 hover:bg-white/10 hover:text-fh-header-text transition-colors"
        >
          <IssueGlyph />
        </Link>
        <Link
          to="/pulls"
          title="Your pull requests"
          aria-label="Your pull requests"
          className="hidden sm:flex items-center justify-center w-8 h-8 rounded-md text-fh-header-text/80 hover:bg-white/10 hover:text-fh-header-text transition-colors"
        >
          <PullGlyph />
        </Link>

        {/* Notifications */}
        <Link
          to="/notifications"
          title="Notifications"
          aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
          className="relative flex items-center justify-center w-8 h-8 rounded-md text-fh-header-text/80 hover:bg-white/10 hover:text-fh-header-text transition-colors"
        >
          <BellIcon size={16} />
          {unreadCount > 0 && (
            <span className="absolute top-1.5 right-1.5 block w-2 h-2 rounded-full bg-fh-header-accent ring-2 ring-fh-header-bg" />
          )}
        </Link>

        {/* Account menu */}
        <DropdownMenu
          align="end"
          width={224}
          trigger={
            <button
              ref={menuBtnRef}
              type="button"
              aria-label="Open account menu"
              className="flex items-center gap-1 pl-1 pr-0.5 h-8 rounded-md hover:bg-white/10 transition-colors cursor-pointer bg-transparent border-none"
            >
              <Avatar name={displayName} src={avatarSrc(user.handle, user.avatarKey)} size={24} />
              <ChevronDownIcon size={12} className="text-fh-header-muted" />
            </button>
          }
        >
          <div className="px-3 py-2 border-b border-fh-border-muted">
            <p className="text-fh-xs text-fh-fg-muted">Signed in as</p>
            <p className="text-fh-sm font-semibold text-fh-fg truncate">{user.handle}</p>
          </div>
          <DropdownItem onSelect={() => navigate(`/${user.handle}`)}>Your profile</DropdownItem>
          <DropdownItem onSelect={() => navigate("/")}>Your repositories</DropdownItem>
          <DropdownItem onSelect={() => navigate("/issues")}>Your issues</DropdownItem>
          <DropdownItem onSelect={() => navigate("/pulls")}>Your pull requests</DropdownItem>
          <DropdownItem onSelect={() => navigate("/?tab=feed")}>Your feed</DropdownItem>
          <DropdownItem onSelect={() => navigate(`/${user.handle}?tab=stars`)}>Your stars</DropdownItem>
          <DropdownItem onSelect={() => navigate("/explore")}>Explore</DropdownItem>
          <DropdownItem onSelect={() => navigate("/organizations/new")}>New organization</DropdownItem>
          <DropdownItem onSelect={() => navigate("/notifications")}>
            Notifications
            {unreadCount > 0 && (
              <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-fh-xs font-semibold bg-fh-neutral-muted text-fh-fg-muted">
                {unreadCount}
              </span>
            )}
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem onSelect={() => navigate("/settings/tokens")}>Settings</DropdownItem>
          <DropdownItem onSelect={() => navigate("/settings/tokens")}>Personal access tokens</DropdownItem>
          <DropdownItem onSelect={() => navigate("/settings/keys")}>SSH keys</DropdownItem>
          <DropdownItem onSelect={() => navigate("/settings/sessions")}>Active sessions</DropdownItem>
          <DropdownItem onSelect={() => navigate("/settings/rendering")}>Rendering</DropdownItem>
          <DropdownSeparator />
          <DropdownItem
            onSelect={toggle}
            leadingIcon={resolved === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          >
            {resolved === "dark" ? "Light theme" : "Dark theme"}
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem onSelect={onLogout}>Sign out</DropdownItem>
        </DropdownMenu>
      </div>
    </header>
  );
}

function PlusGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </svg>
  );
}

function IssueGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
    </svg>
  );
}

function PullGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}
