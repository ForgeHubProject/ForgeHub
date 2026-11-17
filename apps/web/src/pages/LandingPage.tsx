import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { exploreRepos, getServerInfo } from "../api";
import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { FORMAT_FAMILY_LABELS, formatLabel } from "../lib/formats";
import { GUEST, signInPath } from "../lib/guest";
import type { ExploreRepo } from "../types";
import { Button, Skeleton, cx, useTheme } from "../ui";
import { RepoIcon } from "./listShared";
import { useDocumentTitle } from "./useDocumentTitle";
import diff3dLight from "../assets/landing/diff-3d-light.webp";
import diff3dDark from "../assets/landing/diff-3d-dark.webp";
import pullsLight from "../assets/landing/pulls-light.webp";
import pullsDark from "../assets/landing/pulls-dark.webp";
import psdLight from "../assets/landing/psd-light.webp";
import psdDark from "../assets/landing/psd-dark.webp";

/**
 * The signed-out home page (`/`): GitHub's landing page, laid out the same way
 * (a sign-up hero over a product shot, the platform, more ways to use it, the
 * repositories people are starring, a closing sign-up) and saying what ForgeHub
 * does differently: every format gets a diff that reads as what it is.
 *
 * The screenshots are the real app on the Lanternfall demo (PR #1, the keeper's
 * cloak); `scripts/landing-screenshots.mjs` retakes them.
 */
export function LandingPage({ onLogout }: { onLogout: () => void }) {
  useDocumentTitle("ForgeHub: version control for everything you make");
  const [registration, setRegistration] = useState<"open" | "closed">("open");
  const [repos, setRepos] = useState<ExploreRepo[] | null>(null);

  useEffect(() => {
    // Optimistic, as the sign-in page is: a failed fetch never hides sign-up (the API still enforces).
    getServerInfo()
      .then((info) => setRegistration(info.registration === "closed" ? "closed" : "open"))
      .catch(() => {});
    exploreRepos(null, { sort: "stars" })
      .then((d) => setRepos(featured(d.repos)))
      .catch(() => setRepos([]));
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-fh-canvas">
      <Header user={GUEST} token="" onLogout={onLogout} />
      <main className="flex-1">
        <Hero registration={registration} />
        <Platform />
        <Formats />
        <Featured repos={repos} />
        <Closing registration={registration} />
      </main>
      <Footer />
    </div>
  );
}

export const FEATURED_COUNT = 6;

/** The most-starred public repositories that say what they are: a front page has no room for test repos. */
export function featured(repos: ExploreRepo[]): ExploreRepo[] {
  return repos.filter((r) => r.description?.trim()).slice(0, FEATURED_COUNT);
}

// ─── Hero ────────────────────────────────────────────────────────────────────

function Hero({ registration }: { registration: "open" | "closed" }) {
  return (
    <section className="border-b border-fh-border bg-fh-surface">
      <div className="mx-auto max-w-[1280px] px-4 pt-12 text-center sm:pt-16">
        <Link
          to="/explore"
          className="inline-flex items-center gap-1.5 rounded-full border border-fh-border bg-fh-canvas px-3 py-1 text-fh-sm text-fh-fg-muted hover:border-fh-border-strong hover:text-fh-fg"
        >
          See what people are building
          <ChevronRight />
        </Link>
        {/* The one place in the app with display type: a landing page's headline (DESIGN.md §5). */}
        <h1 className="mx-auto mt-6 max-w-3xl text-[36px] font-semibold leading-[44px] tracking-tight text-fh-fg sm:text-[48px] sm:leading-[56px]">
          Version control for everything you make
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-fh-lg text-fh-fg-muted">
          Code, 3D models, Photoshop files, designs and data in one repository, with pull requests that show what changed
          in each of them.
        </p>
        <SignUp registration={registration} className="mt-8 justify-center" />

        <figure className="mx-auto mt-12 max-w-[1100px] overflow-hidden rounded-t-md border border-b-0 border-fh-border bg-fh-canvas text-left">
          <figcaption className="flex items-center gap-2 border-b border-fh-border px-3 py-2 text-fh-sm text-fh-fg-muted">
            <PullGlyph />
            <span className="min-w-0 truncate">
              <span className="font-semibold text-fh-fg">Keeper: hooded cloak, lantern raised</span> #1 ·{" "}
              <span className="font-mono">assets/models/characters/keeper.glb</span>
            </span>
          </figcaption>
          <Shot
            light={diff3dLight}
            dark={diff3dDark}
            width={1600}
            height={1051}
            alt="A pull request's 3D model change: the keeper's raised arm moved 170 mm, a cloak and hood added, two materials recoloured, highlighted on the model."
            eager
          />
        </figure>
      </div>
    </section>
  );
}

/**
 * Sign up with an email (carried to the sign-up form in router state, not the
 * URL), or, where sign-up is closed, sign in. Explore sits beside either.
 */
export function SignUp({ registration, className }: { registration: "open" | "closed"; className?: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const id = useId();
  const explore = (
    <Link to="/explore" className={cx(LINK_BUTTON, "border-fh-border bg-fh-surface text-fh-fg hover:border-fh-border-strong hover:bg-fh-surface-muted")}>
      Explore repositories
    </Link>
  );

  if (registration === "closed") {
    return (
      <div className={cx("flex flex-wrap items-center gap-3", className)}>
        <Link to={signInPath("/")} className={cx(LINK_BUTTON, "border-transparent bg-fh-accent-emphasis text-fh-on-emphasis hover:bg-fh-accent-emphasis-hover")}>
          Sign in
        </Link>
        {explore}
      </div>
    );
  }

  return (
    <form
      className={cx("flex flex-col items-stretch gap-3 sm:flex-row sm:items-center", className)}
      onSubmit={(e) => {
        e.preventDefault();
        navigate(signInPath("/", "register"), { state: { email: email.trim() } });
      }}
    >
      <div className="flex w-full items-center gap-1 rounded-md border border-fh-border bg-fh-canvas p-1 focus-within:border-fh-accent-emphasis sm:w-[420px]">
        <label htmlFor={id} className="sr-only">
          Email address
        </label>
        <input
          id={id}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 bg-transparent px-2 text-fh-base text-fh-fg outline-none placeholder:text-fh-fg-placeholder"
        />
        <Button type="submit" variant="primary" className="h-9 px-4">
          Sign up for ForgeHub
        </Button>
      </div>
      {explore}
    </form>
  );
}

const LINK_BUTTON = "inline-flex h-11 items-center justify-center rounded-md border px-4 text-fh-base font-medium transition-colors";

// ─── Platform ────────────────────────────────────────────────────────────────

function Platform() {
  return (
    <section className="mx-auto max-w-[1280px] px-4 py-16">
      <SectionHeading title="One place for the whole project" />
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <PlatformCard
          title="Repositories and review"
          body="Git hosting with branches, pull requests, issues, releases and organizations. Clone over HTTPS or SSH, as with any Git host."
          shot={{ light: pullsLight, dark: pullsDark, width: 1200, height: 900, alt: "A repository's open pull requests: a HUD change, a moth swarm, a level's side passage and the keeper's cloak." }}
          links={[{ to: "/explore", label: "Explore repositories" }]}
        />
        <PlatformCard
          title="A diff for each format"
          body="Line diffs work for code. For everything else, a format plugin reads the file: the layers of a PSD, the parts of a model, the cells of a table."
          shot={{ light: psdLight, dark: psdDark, width: 1200, height: 900, alt: "A Photoshop file's change side by side: the keeper's lantern raised, a cloak layer added, each layer's moves listed." }}
          links={[{ to: "#formats", label: "See the formats" }]}
        />
      </div>
    </section>
  );
}

function PlatformCard({
  title,
  body,
  shot,
  links,
}: {
  title: string;
  body: string;
  shot: { light: string; dark: string; width: number; height: number; alt: string };
  links: Array<{ to: string; label: string }>;
}) {
  return (
    <article className="flex flex-col overflow-hidden rounded-md border border-fh-border bg-fh-surface">
      <div className="border-b border-fh-border bg-fh-canvas p-4 sm:p-6">
        <div className="overflow-hidden rounded-md border border-fh-border">
          <Shot {...shot} />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center p-6 text-center">
        <h3 className="text-fh-xl font-semibold text-fh-fg">{title}</h3>
        <p className="mt-2 max-w-md text-fh-base text-fh-fg-muted">{body}</p>
        <div className="mt-4 flex gap-3">
          {links.map((l) =>
            l.to.startsWith("#") ? (
              <a key={l.to} href={l.to} className={cx(SMALL_LINK_BUTTON)}>
                {l.label}
              </a>
            ) : (
              <Link key={l.to} to={l.to} className={cx(SMALL_LINK_BUTTON)}>
                {l.label}
              </Link>
            ),
          )}
        </div>
      </div>
    </article>
  );
}

const SMALL_LINK_BUTTON =
  "inline-flex h-8 items-center rounded-md border border-fh-border bg-fh-surface px-3 text-fh-base font-medium text-fh-fg hover:border-fh-border-strong hover:bg-fh-surface-muted";

// ─── Formats ─────────────────────────────────────────────────────────────────

/**
 * What each format family's diff shows, 3D first. Every family Explore
 * filters by has a card (a test holds them in step).
 */
export const FORMAT_CARDS: Array<{ family: string; noun: string; extensions: string[]; body: string }> = [
  {
    family: "3d",
    noun: "3D models",
    extensions: ["glTF", "GLB", "OBJ", "STL", "3MF", "PLY", "FBX", "USD", "Blender", "X3D"],
    body: "Which parts moved and by how much, in real units, what was added or recoloured, and both versions in one 3D view.",
  },
  {
    family: "psd",
    noun: "Photoshop files",
    extensions: ["PSD", "PSB"],
    body: "Layer by layer: what moved, resized, was hidden or repainted, with the image before and after.",
  },
  {
    family: "figcraft",
    noun: "FigCraft designs",
    extensions: ["FigCraft"],
    body: "Frames and components compared on the canvas, and merged when two branches change one design.",
  },
  {
    family: "images",
    noun: "images",
    extensions: ["PNG", "JPEG", "GIF", "SVG"],
    body: "Side by side, with a slider, or only the pixels that changed.",
  },
  {
    family: "cad",
    noun: "CAD drawings",
    extensions: ["DXF"],
    body: "A drawing's model space as 3D geometry, one object per layer, in the drawing's units.",
  },
  {
    family: "data",
    noun: "tables and maps",
    extensions: ["CSV", "GeoJSON"],
    body: "Rows, columns and single cells for tables; features and their properties for maps.",
  },
  {
    family: "notebooks",
    noun: "notebooks",
    extensions: ["Jupyter"],
    body: "Cell by cell, sources and outputs, without the execution-count noise.",
  },
  {
    family: "audio",
    noun: "audio",
    extensions: ["WAV"],
    body: "Sample rate, channels, bit depth and duration.",
  },
];

function Formats() {
  return (
    <section id="formats" className="scroll-mt-16 border-y border-fh-border bg-fh-surface">
      <div className="mx-auto max-w-[1280px] px-4 py-16">
        <SectionHeading
          title="Diffs for the files you actually work with"
          body="Each format family has its own plugin, so a change reads as what it is, worked out on the server or right in your browser."
        />
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FORMAT_CARDS.map((card) => {
            const label = FORMAT_FAMILY_LABELS[card.family] ?? card.family;
            return (
              <li key={card.family} className="flex flex-col rounded-md border border-fh-border bg-fh-canvas p-4">
                <h3 className="text-fh-lg font-semibold text-fh-fg">{label}</h3>
                <p className="mt-1 flex-1 text-fh-base text-fh-fg-muted">{card.body}</p>
                <ul className="mt-3 flex flex-wrap gap-1" aria-label={`${label} formats`}>
                  {card.extensions.map((ext) => (
                    <li key={ext} className="rounded-full border border-fh-border px-1.5 text-fh-xs text-fh-fg-muted">
                      {ext}
                    </li>
                  ))}
                </ul>
                <Link to={`/explore?format=${card.family}`} className="mt-3 text-fh-sm font-medium text-fh-accent-fg hover:underline">
                  Repositories with {card.noun}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

// ─── Featured repositories ───────────────────────────────────────────────────

export function Featured({ repos }: { repos: ExploreRepo[] | null }) {
  // Nothing public yet: no section, rather than an empty one on the front page.
  if (repos && repos.length === 0) return null;
  return (
    <section className="mx-auto max-w-[1280px] px-4 py-16">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-fh-2xl font-semibold text-fh-fg">Featured repositories</h2>
        <Link to="/explore" className="text-fh-base font-medium text-fh-accent-fg hover:underline">
          Explore more
        </Link>
      </div>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {repos === null
          ? Array.from({ length: FEATURED_COUNT }, (_, i) => (
              <li key={i}>
                <Skeleton width="100%" height={132} />
              </li>
            ))
          : repos.map((r) => (
              <li key={r.id} className="flex flex-col rounded-md border border-fh-border bg-fh-surface p-4">
                <div className="flex min-w-0 items-center gap-2">
                  <RepoIcon className="shrink-0 text-fh-fg-muted" />
                  <Link to={`/${r.ownerHandle}/${r.name}`} className="truncate text-fh-base font-semibold text-fh-accent-fg hover:underline">
                    {r.fullName ?? `${r.ownerHandle}/${r.name}`}
                  </Link>
                </div>
                <p className="mt-2 line-clamp-2 flex-1 text-fh-sm text-fh-fg-muted">{r.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-fh-xs text-fh-fg-muted">
                  <span>★ {r.starCount ?? 0}</span>
                  {r.formats.slice(0, 4).map((f) => (
                    <span key={f} className="rounded-full border border-fh-border px-1.5">
                      {formatLabel(f)}
                    </span>
                  ))}
                </div>
              </li>
            ))}
      </ul>
    </section>
  );
}

// ─── Closing sign-up ─────────────────────────────────────────────────────────

function Closing({ registration }: { registration: "open" | "closed" }) {
  return (
    <section className="border-t border-fh-border bg-fh-surface">
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 items-center gap-8 px-4 py-16 md:grid-cols-2">
        <div>
          <p className="font-mono text-fh-sm text-fh-fg-subtle">Open source and self-hostable</p>
          <h2 className="mt-2 text-[32px] font-semibold leading-[40px] tracking-tight text-fh-fg">Bring the whole project</h2>
          <p className="mt-3 max-w-lg text-fh-base text-fh-fg-muted">
            The art, the models, the data and the code that ties them together, in one history.{" "}
            <a href="https://github.com/ForgeHubProject/ForgeHub" className="text-fh-accent-fg hover:underline">
              Run your own ForgeHub
            </a>{" "}
            or start here.
          </p>
        </div>
        <SignUp registration={registration} className="md:justify-end" />
      </div>
    </section>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function SectionHeading({ title, body }: { title: string; body?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <h2 className="text-[32px] font-semibold leading-[40px] tracking-tight text-fh-fg">{title}</h2>
      {body && <p className="mt-3 text-fh-lg text-fh-fg-muted">{body}</p>}
    </div>
  );
}

/** A screenshot in the theme the page is showing. */
function Shot({ light, dark, width, height, alt, eager }: { light: string; dark: string; width: number; height: number; alt: string; eager?: boolean }) {
  const { resolved } = useTheme();
  return (
    <img
      src={resolved === "dark" ? dark : light}
      width={width}
      height={height}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className="block h-auto w-full"
    />
  );
}

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function PullGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="shrink-0 text-fh-success-fg">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}
