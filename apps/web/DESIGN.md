# ForgeHub design foundation

A hand-tuned, GitHub-caliber design system for the ForgeHub web app. This
document is the contract every page agent builds on: the palette, the tokens,
the primitive catalog, and the rules that keep the product feeling like one
coherent, restrained tool rather than a pile of one-off components.

The identity is a **cool, cyan-leaning "open blue"** — deliberately not stock
Tailwind `blue`, not GitHub's `#0969da`, and not the old warm ember orange this
replaces. Neutrals carry a faint blue cast so the whole surface reads cool.

---

## 1. How theming works

Every color is a CSS custom property holding a **space-separated RGB triple**
(e.g. `--fh-accent-emphasis: 11 127 171;`). Tailwind consumes them through
`rgb(var(--fh-x) / <alpha-value>)`, so opacity utilities like
`bg-fh-surface/50` still work.

- Light values live on `:root`, dark values on `.dark` — `tailwind.config.js`
  sets `darkMode: "class"`.
- The `.dark` class is toggled on `<html>` by `src/ui/theme.tsx`
  (`ThemeProvider` / `useTheme`), which persists the choice under the
  `fh_theme` localStorage key and otherwise follows `prefers-color-scheme`.
- `index.html` runs a tiny **no-flash** script before first paint that mirrors
  that logic, so the initial render never flashes the wrong theme. If you change
  the storage key or resolution rule in `theme.tsx`, update that script too.
- **Header tokens (`--fh-header-*`) are theme-independent** — defined only on
  `:root` — because the top bar is a dense dark surface in both themes.

Use tokens through Tailwind classes (`text-fh-fg`, `bg-fh-surface`,
`border-fh-border`). Never hard-code hex in components.

---

## 2. Palette

Hex values are derived from the RGB triples in `src/index.css`. All text/link/
accent pairs below are **mathematically verified for WCAG 2.1 AA** (normal text
≥ 4.5:1; button/large text ≥ 3:1). Ratios computed with the standard relative-
luminance formula (the same math ships in `src/ui/color.ts`).

### Light theme

| Token | Hex | Role |
| --- | --- | --- |
| `canvas` | `#f6f8fb` | app background |
| `surface` | `#ffffff` | cards, panels, inputs |
| `surface-muted` | `#eef2f7` | subtle fills, code blocks, hover |
| `surface-inset` | `#f1f4f8` | inset wells |
| `border` | `#d5dde6` | default hairline border |
| `border-muted` | `#e6ebf1` | faint dividers |
| `border-strong` | `#c2ccd6` | hover / emphasized border |
| `fg` | `#111820` | primary text |
| `fg-muted` | `#586675` | secondary text |
| `fg-subtle` | `#6b7885` | tertiary text, timestamps |
| `fg-placeholder` | `#8b97a4` | input placeholders |
| `accent-fg` | `#0b6f96` | links, accent text |
| `accent-emphasis` | `#0b7fab` | primary buttons, active underline |
| `accent-emphasis-hover` | `#095f80` | primary button hover |
| `accent-muted` | `#e2f2f9` | accent wash (badges, menu hover) |
| `on-emphasis` | `#ffffff` | text on accent-emphasis |
| `success-fg` | `#137a4b` | success text |
| `success-muted` | `#dff3e8` | success wash |
| `danger-fg` | `#c2352f` | danger text |
| `danger-muted` | `#fce4e2` | danger wash |
| `warning-fg` | `#8f6200` | warning text |
| `warning-muted` | `#fbefd0` | warning wash |
| `purple-fg` | `#7a44d6` | "done"/merged accent |
| `purple-muted` | `#efe8fc` | purple wash |
| `neutral-muted` | `#eaeef3` | counters, neutral pills |

### Dark theme

| Token | Hex | Role |
| --- | --- | --- |
| `canvas` | `#0b0f14` | app background |
| `surface` | `#11161d` | cards, panels, inputs |
| `surface-muted` | `#161d26` | subtle fills, code blocks, hover |
| `surface-inset` | `#0d1219` | inset wells |
| `border` | `#242e3a` | default hairline border |
| `border-muted` | `#1c242e` | faint dividers |
| `border-strong` | `#324152` | hover / emphasized border |
| `fg` | `#e6edf3` | primary text |
| `fg-muted` | `#93a1b0` | secondary text |
| `fg-subtle` | `#7d8b9a` | tertiary text, timestamps |
| `fg-placeholder` | `#6a7887` | input placeholders |
| `accent-fg` | `#39c0e8` | links, accent text |
| `accent-emphasis` | `#39c0e8` | primary buttons, active underline |
| `accent-emphasis-hover` | `#5accef` | primary button hover |
| `accent-muted` | `#10303d` | accent wash |
| `on-emphasis` | `#04141d` | text on accent-emphasis |
| `success-fg` | `#3fb27f` | success text |
| `success-muted` | `#123024` | success wash |
| `danger-fg` | `#f0736b` | danger text |
| `danger-muted` | `#3a1f1e` | danger wash |
| `warning-fg` | `#d8a63a` | warning text |
| `warning-muted` | `#332813` | warning wash |
| `purple-fg` | `#a884f3` | "done"/merged accent |
| `purple-muted` | `#241a3a` | purple wash |
| `neutral-muted` | `#1c242e` | counters, neutral pills |

### Header (both themes)

| Token | Hex | Role |
| --- | --- | --- |
| `header-bg` | `#0d1219` | top-bar surface |
| `header-text` | `#e7edf3` | top-bar text |
| `header-muted` | `#9aa7b4` | top-bar secondary text/icons |
| `header-border` | `#212a35` | top-bar borders / input outlines |
| `header-accent` | `#39c0e8` | brand mark, focus, unread dot |

### Verified contrast ratios

| Theme | Foreground | Background | Ratio | WCAG |
| --- | --- | --- | --- | --- |
| light | fg `#111820` | canvas `#f6f8fb` | 16.79:1 | AA |
| light | fg `#111820` | surface `#ffffff` | 17.87:1 | AA |
| light | fg-muted `#586675` | surface `#ffffff` | 5.88:1 | AA |
| light | fg-muted `#586675` | canvas `#f6f8fb` | 5.53:1 | AA |
| light | fg-subtle `#6b7885` | surface `#ffffff` | 4.52:1 | AA |
| light | accent-fg `#0b6f96` | surface `#ffffff` | 5.63:1 | AA |
| light | accent-fg `#0b6f96` | canvas `#f6f8fb` | 5.29:1 | AA |
| light | on-emphasis `#ffffff` | accent-emphasis `#0b7fab` | 4.53:1 | AA |
| light | success-fg `#137a4b` | surface `#ffffff` | 5.37:1 | AA |
| light | danger-fg `#c2352f` | surface `#ffffff` | 5.46:1 | AA |
| light | warning-fg `#8f6200` | surface `#ffffff` | 5.36:1 | AA |
| light | purple-fg `#7a44d6` | surface `#ffffff` | 5.79:1 | AA |
| dark | fg `#e6edf3` | canvas `#0b0f14` | 16.27:1 | AA |
| dark | fg `#e6edf3` | surface `#11161d` | 15.37:1 | AA |
| dark | fg-muted `#93a1b0` | surface `#11161d` | 6.89:1 | AA |
| dark | fg-muted `#93a1b0` | canvas `#0b0f14` | 7.29:1 | AA |
| dark | fg-subtle `#7d8b9a` | surface `#11161d` | 5.22:1 | AA |
| dark | accent-fg `#39c0e8` | surface `#11161d` | 8.54:1 | AA |
| dark | accent-fg `#39c0e8` | canvas `#0b0f14` | 9.04:1 | AA |
| dark | on-emphasis `#04141d` | accent-emphasis `#39c0e8` | 8.80:1 | AA |
| dark | success-fg `#3fb27f` | surface `#11161d` | 6.82:1 | AA |
| dark | danger-fg `#f0736b` | surface `#11161d` | 6.37:1 | AA |
| dark | warning-fg `#d8a63a` | surface `#11161d` | 8.16:1 | AA |
| dark | purple-fg `#a884f3` | surface `#11161d` | 6.28:1 | AA |
| header | header-text `#e7edf3` | header-bg `#0d1219` | 15.93:1 | AA |
| header | header-muted `#9aa7b4` | header-bg `#0d1219` | 7.66:1 | AA |
| header | header-accent `#39c0e8` | header-bg `#0d1219` | 8.84:1 | AA |

Recompute anytime you touch a token by running the checked-in audit — it reads
the same triples and reprints this table:

```bash
node scripts/contrast-audit.mjs
```

The source math also ships in `src/ui/color.ts` (`contrastRatio`,
`readableTextOn`) — the runtime uses it for label-chip ink.

---

## 3. Token reference

- **Surfaces** stack `canvas` (page) → `surface` (card) → `surface-muted`
  (fills/hover). Never put a `surface` card directly on `surface`; separate them
  with a `border` or the `canvas`.
- **Text** descends `fg` → `fg-muted` → `fg-subtle` → `fg-placeholder`. Body
  copy is `fg-muted`; only headings and primary values get `fg`.
- **Accent** is used sparingly: links (`accent-fg`), the one primary action per
  view (`accent-emphasis`), and active-state underlines. `accent-muted` is the
  only accent fill (menu/hover/badge washes).
- **Semantic** colors (`success`/`danger`/`warning`/`purple`) always come as a
  `-fg` (text) + `-muted` (wash) pair. `purple` is the "done/merged" color.
- **Legacy `gh.*` aliases** (`gh-bg`, `gh-accent`, `gh-text`, …) are remapped
  onto the same vars so not-yet-migrated pages keep working and inherit dark
  mode for free. Do **not** write new `gh-*` classes — migrate to `fh-*`.

Type scale is exposed as `text-fh-xs` (11) / `-sm` (12) / `-base` (14) /
`-lg` (16) / `-xl` (20) / `-2xl` (24). Radius is `6px` (`rounded-md`). Overlay
shadow is `shadow-overlay`; there is no other elevation.

---

## 4. Primitive catalog

Everything lives in `src/ui/`, re-exported from `src/ui/index.ts`. Import from
the barrel:

```tsx
import { Button, TabNav, TabItem, Badge, LabelChip, Avatar, DropdownMenu,
  DropdownItem, Dialog, ConfirmDialog, TextInput, Textarea, Select, Field,
  EmptyState, Spinner, Skeleton, Tooltip, Breadcrumbs, PageHeading, Pagination,
  RelativeTime, useToast, useTheme } from "../ui";
```

**Button** — `variant`: primary | default | danger | invisible; `size`: sm | md;
plus `loading`, `leadingIcon`, `trailingIcon`, `block`.

```tsx
<Button variant="primary" onClick={save}>New repository</Button>
<Button variant="danger" size="sm" loading={deleting} onClick={remove}>Delete</Button>
```

**TabNav / TabItem** — icon + label + counter pill, 2px accent underline when
active. Renders a router `Link` when `to` is set, else a button.

```tsx
<TabNav aria-label="Repository">
  <TabItem to="." active icon={<CodeIcon/>}>Code</TabItem>
  <TabItem to="issues" icon={<IssueIcon/>} count={12}>Issues</TabItem>
</TabNav>
```

**Badge / LabelChip** — `Badge` is a semantic pill (`tone`: neutral | accent |
success | danger | warning | purple). `LabelChip` fills with an arbitrary label
color and auto-picks black/white ink for AA contrast.

```tsx
<Badge tone="success">Public</Badge>
<LabelChip name="bug" color="#c2352f" />
```

**Avatar** — image with a deterministic colored-initial fallback (stable per
name). `square` for repos/orgs.

```tsx
<Avatar name={user.displayName ?? user.handle} src={user.avatarUrl} size={32} />
```

**DropdownMenu** — outside-click + Escape + roving arrow-key nav. Compose with
`DropdownItem` / `DropdownSeparator` / `DropdownLabel`.

```tsx
<DropdownMenu trigger={<Button trailingIcon={<ChevronDownIcon/>}>Actions</Button>}>
  <DropdownItem onSelect={edit}>Edit</DropdownItem>
  <DropdownSeparator />
  <DropdownItem danger onSelect={remove}>Delete</DropdownItem>
</DropdownMenu>
```

**Dialog / ConfirmDialog** — portal modal with focus trap, scroll lock, Escape
and backdrop dismissal. `ConfirmDialog` is the destructive-action wrapper (and
`components/ConfirmDialog` is now a thin re-export of it).

```tsx
<ConfirmDialog open={open} title="Delete token?" message="This cannot be undone."
  confirmLabel="Delete" loading={busy} onConfirm={go} onCancel={close} />
```

**Form controls** — `TextInput`, `Textarea`, `Select`, wrapped by `Field`
(label + hint/error, auto-wired ids). All share the accent focus ring.

```tsx
<Field label="Repository name" required hint="Lowercase, numbers, hyphens.">
  {(id) => <TextInput id={id} value={name} onChange={e => setName(e.target.value)} />}
</Field>
```

**State & feedback** — `EmptyState`, `Spinner`, `Skeleton`, `Tooltip`,
`Breadcrumbs`, `PageHeading`, `Pagination`, `RelativeTime` (renders "3 days ago"
with the absolute time in `title`), and a `useToast()` hook backed by
`ToastProvider` (already mounted at the app root).

```tsx
const { toast } = useToast();
toast("Repository created", { tone: "success" });
<RelativeTime date={repo.updatedAt} />
```

**Theme** — `useTheme()` returns `{ mode, resolved, setMode, toggle }`. The
account menu in the header calls `toggle()`.

---

## 5. Style rules (anti-slop)

These are binding. They are what separates "looks like a real tool" from
"looks AI-generated."

1. **System font stack only.** `-apple-system, BlinkMacSystemFont, "Segoe UI"…`
   for UI; `ui-monospace, SFMono-Regular…` for code. No web fonts.
2. **Dense type.** Body is 13–14px (`text-fh-sm`/`text-fh-base`). Headings top
   out at 24px. Resist large hero text.
3. **4px spacing grid.** Use Tailwind's 0.5/1/1.5/2/3/4… steps; no arbitrary
   `17px` gaps.
4. **6px radius everywhere** (`rounded-md`). Pills use `rounded-full`. No
   `rounded-xl`/`2xl` on chrome.
5. **Hairline borders define regions**, not shadows. `border-fh-border`.
6. **Shadows only on overlays** — dropdowns, dialogs, toasts, tooltips
   (`shadow-overlay`). Never on cards or buttons.
7. **No gradients.** Flat fills only.
8. **No emoji in chrome**, no decorative icons. Icons are functional Octicon-
   style 16px marks in `currentColor`.
9. **Sentence case** for buttons, labels, headings ("New repository", not "New
   Repository").
10. **Accent sparingly.** One primary action per view. Everything else is
    `default`/`invisible`. Links are the main accent surface.
11. **Real microcopy.** "No open issues", "Nothing to show here yet" — never
    "Oops!", "Something went wrong 😅", or lorem ipsum.
12. **Every interactive element has a visible `:focus-visible` ring** (the base
    stylesheet provides it; don't remove outlines).
13. **Both themes, always.** If you add a color, add it as a token in both
    `:root` and `.dark`, and check its contrast.

---

## 6. Dev harness

Two scripts under `scripts/` make it easy to see real UI against real data.

**Seed** — populates a running API with a demo user, PAT, repositories (with
real pushed git history, branches, labels, issues, a PR, and a release):

```bash
# API must be running (see below). Then:
node scripts/dev-seed.mjs                 # against http://localhost:3100
API_URL=http://localhost:3100 node scripts/dev-seed.mjs
```

It prints the demo credentials (`demo@forgehub.dev` / `forgehub-demo`) on exit.

**Screenshots** — drives Playwright against the running web app, logging in as
the seed user and capturing routes at 1440×900 and 375×812 in light and dark:

```bash
node scripts/dev-shot.mjs                 # defaults to http://localhost:5100
WEB_URL=http://localhost:5100 SHOT_DIR=./shots node scripts/dev-shot.mjs
```

It uses the system Chromium at `/opt/pw-browsers/chromium` — never run
`playwright install`.

**Full local loop:**

```bash
# API (port 3100, isolated git + sqlite under a scratch dir)
cd apps/api
JWT_SECRET=dev-secret-dev-secret DATABASE_URL="file:./dev.db" \
  GIT_STORAGE_ROOT=/tmp/fh-git PORT=3100 npm run db:push
JWT_SECRET=dev-secret-dev-secret DATABASE_URL="file:./dev.db" \
  GIT_STORAGE_ROOT=/tmp/fh-git PORT=3100 npm run dev &

# Web (port 5100, pointed at the API)
cd ../web
VITE_API_URL=http://localhost:3100 npm run dev -- --port 5100 &

node ../../scripts/dev-seed.mjs
node ../../scripts/dev-shot.mjs
```

---

## 7. Migration contract for page agents

When you migrate or build a page:

- **Compose from `src/ui/` primitives.** Don't hand-roll buttons, inputs,
  dropdowns, dialogs, tabs, badges, avatars, toasts, or pagination.
- **Use semantic tokens only** (`fh-*`, or the legacy `gh-*` aliases while
  migrating). **No raw hex, no `rgb()`/`#…` in JSX or style props.** The one
  sanctioned exception is passing a data-driven color (like a label's own
  `color`) into `LabelChip`, which handles contrast for you.
- **Both themes must look right.** Verify light and dark before you commit.
- **Follow the anti-slop rules in §5.** Sentence case, dense spacing, hairline
  borders, overlay-only shadows, accent sparingly.
- **Keep every existing route working.** These primitives are drop-in; the app
  shell (`Header`, `Footer`) keeps its existing props.
- **Add a token, not a hex,** if you genuinely need a new color — in both
  `:root` and `.dark`, with a checked contrast ratio, documented here.
