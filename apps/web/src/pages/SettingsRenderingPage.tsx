import { useState } from "react";
import { Header } from "../components/Header";
import type { User } from "../types";
import { Badge, Button, EmptyState, PageHeading, Select } from "../ui";
import {
  TIER_LABELS,
  clearTierPreference,
  getGlobalTierPreference,
  isComputeTier,
  listTierPreferences,
  setGlobalTierPreference,
  type ComputeTier,
} from "../lib/computeTier";

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

// ── local Octicon-style marks ─────────────────────────────────────────────────

function Icon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d={path} />
    </svg>
  );
}
const CPU = "M6.5 0a.75.75 0 01.75.75V2h1.5V.75a.75.75 0 011.5 0V2h1a2 2 0 012 2v1h1.25a.75.75 0 010 1.5H13v1.5h1.25a.75.75 0 010 1.5H13v1.5h1.25a.75.75 0 010 1.5H13v1a2 2 0 01-2 2h-1v1.25a.75.75 0 01-1.5 0V14h-1.5v1.25a.75.75 0 01-1.5 0V14h-1a2 2 0 01-2-2v-1H1.25a.75.75 0 010-1.5H2.5V8H1.25a.75.75 0 010-1.5H2.5V5H1.25a.75.75 0 010-1.5H2.5v-1a2 2 0 012-2h1V.75A.75.75 0 016.5 0zM4 4.5v7a.5.5 0 00.5.5h7a.5.5 0 00.5-.5v-7a.5.5 0 00-.5-.5h-7a.5.5 0 00-.5.5zM6 6h4v4H6z";

const TIER_DESCRIPTIONS: Record<ComputeTier, string> = {
  server: "Canonical — computed and cached by ForgeHub; works on any device.",
  browser: "Runs the official handler's wasm build in your browser; downloads both blobs. Falls back to server where unavailable.",
  local: "Hands off to your own forge via a copyable `forge diff --web` command.",
};

/**
 * Device-local rendering preferences (issue #66 P4): where semantic diffs are
 * computed by default, plus the per-format overrides the diff-header pill has
 * accumulated. All of it lives in this browser's localStorage — server-side
 * compute stays the canonical record for review regardless of the choice here.
 */
export function SettingsRenderingPage({ token, user, onLogout }: Props) {
  const [globalTier, setGlobalTier] = useState<ComputeTier | null>(() => getGlobalTierPreference());
  const [overrides, setOverrides] = useState(() => listTierPreferences());

  function changeGlobal(value: string) {
    const tier = isComputeTier(value) ? value : null;
    setGlobalTierPreference(tier);
    setGlobalTier(tier);
  }

  function clearOverride(ext: string) {
    clearTierPreference(ext);
    setOverrides(listTierPreferences());
  }

  return (
    <div className="min-h-screen bg-fh-canvas">
      <Header user={user} onLogout={onLogout} token={token} />

      <div className="max-w-[900px] mx-auto px-4 py-8">
        <PageHeading
          title="Rendering"
          icon={<Icon path={CPU} size={20} />}
          description="Where semantic diffs are computed for you, on this device. Server compute remains the canonical record for review either way."
          divider
        />

        <section className="bg-fh-surface border border-fh-border rounded-md px-4 py-4">
          <h2 className="text-fh-base font-semibold text-fh-fg">Default compute tier</h2>
          <p className="mt-1 text-fh-sm text-fh-fg-muted">
            Used for every semantic format you haven't chosen a tier for individually.
          </p>
          <div className="mt-3 max-w-[320px]">
            <Select value={globalTier ?? ""} onChange={(e) => changeGlobal(e.target.value)} aria-label="Default compute tier">
              <option value="">Tier S — server (default)</option>
              <option value="browser">Tier B — browser</option>
              <option value="local">Tier L — local (forge)</option>
            </Select>
          </div>
          <p className="mt-2 text-fh-xs text-fh-fg-subtle">
            {TIER_DESCRIPTIONS[globalTier ?? "server"]}
          </p>
        </section>

        <section className="mt-4 bg-fh-surface border border-fh-border rounded-md">
          <div className="px-4 py-3 border-b border-fh-border">
            <h2 className="text-fh-base font-semibold text-fh-fg">Per-format choices</h2>
            <p className="mt-1 text-fh-sm text-fh-fg-muted">
              Set from the tier pill on a diff header; each one overrides the default above for its format.
            </p>
          </div>
          {overrides.length === 0 ? (
            <EmptyState
              icon={<Icon path={CPU} size={32} />}
              title="No per-format choices yet"
              description="Switch the compute tier on any semantic diff and the choice will stick for that format, listed here."
            />
          ) : (
            <div className="divide-y divide-fh-border">
              {overrides.map(({ ext, tier }) => (
                <div key={ext} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <code className="font-mono text-fh-sm text-fh-fg">.{ext}</code>
                    <Badge tone={tier === "server" ? "neutral" : "accent"}>
                      Tier {TIER_LABELS[tier].tier} — {TIER_LABELS[tier].label}
                    </Badge>
                  </div>
                  <Button variant="default" size="sm" onClick={() => clearOverride(ext)}>
                    Reset
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
