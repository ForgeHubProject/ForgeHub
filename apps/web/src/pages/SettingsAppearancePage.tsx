import { SettingsLayout } from "../components/SettingsLayout";
import type { User } from "../types";
import { PageHeading, cx, useTheme, type ThemeMode } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

const MODES: Array<{ mode: ThemeMode; label: string; hint: string }> = [
  { mode: "system", label: "Sync with system", hint: "Follow your device's light or dark setting." },
  { mode: "light", label: "Light", hint: "Always light." },
  { mode: "dark", label: "Dark", hint: "Always dark." },
];

/** Settings → Appearance (#258): the theme, which used to live in the account menu. */
export function SettingsAppearancePage({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  useDocumentTitle("Appearance · Settings · ForgeHub");
  const { mode, setMode } = useTheme();
  return (
    <SettingsLayout token={token} user={user} onLogout={onLogout}>
      <PageHeading title="Appearance" divider />
      <h2 className="mb-1 text-fh-base font-semibold text-fh-fg">Theme mode</h2>
      <p className="mb-4 text-fh-sm text-fh-fg-muted">Choose how ForgeHub looks to you. This is kept in this browser.</p>
      <div role="radiogroup" aria-label="Theme mode" className="grid gap-3 sm:grid-cols-3">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={mode === m.mode}
            onClick={() => setMode(m.mode)}
            className={cx(
              "rounded-md border p-4 text-left",
              mode === m.mode ? "border-fh-accent-emphasis bg-fh-accent-muted" : "border-fh-border bg-fh-surface hover:border-fh-border-strong",
            )}
          >
            <ThemePreview mode={m.mode} />
            <p className="mt-3 text-fh-base font-semibold text-fh-fg">{m.label}</p>
            <p className="text-fh-sm text-fh-fg-muted">{m.hint}</p>
          </button>
        ))}
      </div>
    </SettingsLayout>
  );
}

/** A tiny page sketch in each theme's colours (system shows both halves). */
function ThemePreview({ mode }: { mode: ThemeMode }) {
  const half = (dark: boolean) => (
    <div className={cx("flex-1 p-2", dark ? "bg-[#0d1117]" : "bg-[#ffffff]")}>
      <div className={cx("mb-1.5 h-1.5 w-1/2 rounded", dark ? "bg-[#30363d]" : "bg-[#d0d7de]")} />
      <div className={cx("mb-1 h-1 w-3/4 rounded", dark ? "bg-[#21262d]" : "bg-[#eaeef2]")} />
      <div className={cx("h-1 w-2/3 rounded", dark ? "bg-[#21262d]" : "bg-[#eaeef2]")} />
    </div>
  );
  return (
    <div aria-hidden className="flex h-16 overflow-hidden rounded border border-fh-border">
      {mode !== "dark" && half(false)}
      {mode !== "light" && half(true)}
    </div>
  );
}
