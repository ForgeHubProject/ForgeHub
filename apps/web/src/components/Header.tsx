import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { listNotifications } from "../api";
import { ForgeLogo } from "./ForgeLogo";
import type { User } from "../types";
import { Avatar } from "../ui/Avatar";
import { DropdownItem, DropdownMenu, DropdownSeparator } from "../ui/DropdownMenu";
import { useTheme } from "../ui/theme";
import { BellIcon, ChevronDownIcon, MoonIcon, SearchIcon, SunIcon } from "../ui/icons";

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

      {/* Owner crumb */}
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
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search repositories"
            aria-label="Search"
            className="w-full h-8 pl-8 pr-3 text-fh-sm rounded-md border outline-none bg-white/[0.06] border-fh-header-border text-fh-header-text placeholder:text-fh-header-muted transition-colors focus:bg-fh-surface focus:text-fh-fg focus:border-fh-header-accent focus:placeholder:text-fh-fg-placeholder"
          />
        </div>
      </form>

      {/* Actions */}
      <div className="flex items-center gap-0.5 ml-auto sm:ml-0">
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
              <Avatar name={displayName} size={24} />
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
