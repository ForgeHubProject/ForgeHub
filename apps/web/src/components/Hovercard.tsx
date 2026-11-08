import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { avatarSrc, getPublicProfile, setFollowing } from "../api";
import type { PublicProfile } from "../types";
import { Avatar, Button } from "../ui";
import { LocationIcon } from "../pages/listShared";

/** Site pages at the top level: a link to one of these is not a person (the API's RESERVED_HANDLES, less "ghost", which is a profile). */
const RESERVED = new Set([
  "about", "explore", "feed", "import", "issues", "login", "logout", "new", "notifications",
  "organizations", "orgs", "pulls", "search", "settings", "stars", "topics", "trending",
]);

/**
 * The handle a link points at when it is a person's profile (`/<handle>`, no
 * query or hash), else null. Organizations share the handle space; their
 * profile lookup 404s and no card shows.
 */
export function hovercardHandle(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.search || url.hash) return null;
  const m = /^\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/?$/.exec(url.pathname);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  return m[1];
}

const OPEN_DELAY = 450;
const CLOSE_DELAY = 250;
const CARD_WIDTH = 320;

type Anchor = { handle: string; rect: DOMRect };

/**
 * GitHub's hovercards (#257): hovering a link to someone's profile anywhere
 * (mentions, authors, people lists) shows who they are. One listener for the
 * whole app; a link opts out with `data-no-hovercard` on it or an ancestor.
 */
export function HovercardLayer({ token, selfHandle }: { token: string; selfHandle: string }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, PublicProfile | null>());

  useEffect(() => {
    let openTimer: number | undefined;
    let closeTimer: number | undefined;
    let current: Element | null = null;

    function onOver(e: MouseEvent) {
      const target = e.target as Element | null;
      if (!target?.closest) return;
      if (cardRef.current?.contains(target)) {
        window.clearTimeout(closeTimer);
        return;
      }
      const link = target.closest("a[href]") as HTMLAnchorElement | null;
      const handle =
        link && !link.closest("[data-no-hovercard]") && link.getAttribute("role") !== "tab"
          ? hovercardHandle(link.getAttribute("href")!, window.location.origin)
          : null;
      if (handle && link) {
        window.clearTimeout(closeTimer);
        if (link === current) return;
        current = link;
        window.clearTimeout(openTimer);
        openTimer = window.setTimeout(() => setAnchor({ handle, rect: link.getBoundingClientRect() }), OPEN_DELAY);
        return;
      }
      current = null;
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => setAnchor(null), CLOSE_DELAY);
    }
    const close = () => {
      current = null;
      window.clearTimeout(openTimer);
      setAnchor(null);
    };

    document.addEventListener("mouseover", onOver);
    window.addEventListener("scroll", close, true);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("mouseover", onOver);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("click", close);
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
    };
  }, []);

  if (!anchor) return null;
  // Below the link, or above it when there's no room; kept inside the viewport.
  const below = anchor.rect.bottom + 8;
  const left = Math.max(8, Math.min(anchor.rect.left, window.innerWidth - CARD_WIDTH - 8));
  const fitsBelow = below + 220 < window.innerHeight;
  const style: React.CSSProperties = fitsBelow
    ? { top: below, left, width: CARD_WIDTH }
    : { bottom: window.innerHeight - anchor.rect.top + 8, left, width: CARD_WIDTH };
  return (
    <div ref={cardRef} role="dialog" aria-label={`About ${anchor.handle}`} className="fixed z-50" style={style}>
      <HovercardBody key={anchor.handle} token={token} handle={anchor.handle} self={anchor.handle.toLowerCase() === selfHandle.toLowerCase()} cache={cache.current} />
    </div>
  );
}

function HovercardBody({ token, handle, self, cache }: { token: string; handle: string; self: boolean; cache: Map<string, PublicProfile | null> }) {
  const [profile, setProfile] = useState<PublicProfile | null | undefined>(cache.get(handle.toLowerCase()));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (profile !== undefined) return;
    let live = true;
    getPublicProfile(token, handle)
      .then((p) => {
        cache.set(handle.toLowerCase(), p);
        if (live) setProfile(p);
      })
      .catch(() => {
        cache.set(handle.toLowerCase(), null);
        if (live) setProfile(null);
      });
    return () => {
      live = false;
    };
  }, [token, handle, profile, cache]);

  if (profile === null) return null; // an organization, or nobody
  if (profile === undefined) {
    return <div className="h-24 rounded-md border border-fh-border bg-fh-surface shadow-lg" aria-busy="true" />;
  }

  async function toggleFollow() {
    if (!profile) return;
    setBusy(true);
    try {
      const res = await setFollowing(token, profile.handle, !profile.viewerFollows);
      const next = { ...profile, viewerFollows: res.following, followers: res.followers };
      cache.set(handle.toLowerCase(), next);
      setProfile(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-fh-border bg-fh-surface p-4 text-fh-sm shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/${profile.handle}`}>
          <Avatar name={profile.displayName || profile.handle} src={avatarSrc(profile.handle, profile.avatarKey)} size={48} />
        </Link>
        {!self && (
          <Button size="sm" variant="default" loading={busy} onClick={() => void toggleFollow()}>
            {profile.viewerFollows ? "Unfollow" : "Follow"}
          </Button>
        )}
      </div>
      <p className="mt-2">
        <Link to={`/${profile.handle}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">
          {profile.displayName || profile.handle}
        </Link>{" "}
        <span className="text-fh-fg-muted">
          {profile.handle}
          {profile.pronouns && ` · ${profile.pronouns}`}
        </span>
      </p>
      {profile.bio && <p className="mt-1 text-fh-fg">{profile.bio}</p>}
      {profile.status && (
        <p className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-fh-border px-2.5 py-0.5 text-fh-xs text-fh-fg">
          {profile.status.emoji && <span aria-hidden>{profile.status.emoji}</span>}
          <span className="truncate">{profile.status.text}</span>
        </p>
      )}
      {(profile.company || profile.location) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 text-fh-xs text-fh-fg-muted">
          {profile.company && <span>{profile.company}</span>}
          {profile.location && (
            <span className="inline-flex items-center gap-1">
              <LocationIcon size={12} />
              {profile.location}
            </span>
          )}
        </p>
      )}
      {profile.followers != null && (
        <p className="mt-2 text-fh-xs text-fh-fg-muted">
          <span className="font-semibold text-fh-fg">{profile.followers}</span> {profile.followers === 1 ? "follower" : "followers"}
          {" · "}
          <span className="font-semibold text-fh-fg">{profile.following ?? 0}</span> following
        </p>
      )}
    </div>
  );
}
