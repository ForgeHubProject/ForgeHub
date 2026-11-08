import { Link, NavLink } from "react-router-dom";
import { avatarSrc } from "../api";
import type { User } from "../types";
import { Avatar, Button, cx } from "../ui";
import { Footer } from "./Footer";
import { Header } from "./Header";

/** The settings sidebar (#258), grouped like GitHub's. */
export const SETTINGS_NAV: Array<{ group?: string; items: Array<{ to: string; label: string }> }> = [
  {
    items: [
      { to: "/settings/profile", label: "Public profile" },
      { to: "/settings/account", label: "Account" },
      { to: "/settings/appearance", label: "Appearance" },
    ],
  },
  {
    group: "Access",
    items: [
      { to: "/settings/sessions", label: "Sessions" },
      { to: "/settings/keys", label: "SSH keys" },
    ],
  },
  {
    group: "Code and review",
    items: [{ to: "/settings/rendering", label: "Rendering" }],
  },
  {
    group: "Developer settings",
    items: [{ to: "/settings/tokens", label: "Personal access tokens" }],
  },
];

/**
 * The frame every settings page sits in (#258): who you are at the top, the
 * sidebar on the left, the page on the right.
 */
export function SettingsLayout({ token, user, onLogout, children }: { token: string; user: User; onLogout: () => void; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />
      <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Avatar name={user.displayName || user.handle} src={avatarSrc(user.handle, user.avatarKey)} size={48} />
          <div className="min-w-0 flex-1">
            <p className="text-fh-lg font-semibold text-fh-fg">
              {user.displayName || user.handle} <span className="font-normal text-fh-fg-muted">({user.handle})</span>
            </p>
            <p className="text-fh-sm text-fh-fg-muted">Your personal account</p>
          </div>
          <Link to={`/${user.handle}`} className="no-underline">
            <Button variant="default" size="sm">Go to your personal profile</Button>
          </Link>
        </div>
        <div className="flex flex-col gap-6 md:flex-row">
          <nav aria-label="Settings" className="w-full flex-shrink-0 md:w-64">
            {SETTINGS_NAV.map((section, i) => (
              <div key={section.group ?? i} className={cx(i > 0 && "mt-3 border-t border-fh-border-muted pt-3")}>
                {section.group && <p className="mb-1 px-3 text-fh-xs font-semibold text-fh-fg-muted">{section.group}</p>}
                <ul>
                  {section.items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        className={({ isActive }) =>
                          cx(
                            "relative block rounded-md px-3 py-1.5 text-fh-base no-underline",
                            isActive
                              ? "bg-fh-surface-muted font-semibold text-fh-fg before:absolute before:-left-1 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-full before:bg-fh-accent-emphasis"
                              : "text-fh-fg hover:bg-fh-surface-muted",
                          )
                        }
                      >
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
      <Footer />
    </div>
  );
}
