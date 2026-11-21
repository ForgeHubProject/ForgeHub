import { useEffect, useRef, useState } from "react";
import { getIssueImport, retryIssueImport, type IssueImport } from "../../../api";
import { Button, useToast } from "../../../ui";
import { useRepoPermission } from "../permission";

/** How often a running import is asked how far it has got. */
const POLL_MS = 10_000;

/** "14:20" in the viewer's time. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "140 issues and 212 comments" */
export function importedSoFar(i: Pick<IssueImport, "issues" | "comments">): string {
  const n = (k: number, one: string) => `${k.toLocaleString("en-US")} ${one}${k === 1 ? "" : "s"}`;
  return `${n(i.issues, "issue")} and ${n(i.comments, "comment")}`;
}

/**
 * The Issues tab while a GitHub import is bringing the issues over (#289, phase 2):
 * how far it has got, when it carries on after GitHub's hourly limit, and Retry
 * for admins when it stopped. `onProgress` runs when more issues have landed, so
 * the list can show them. Nothing shows once it's done.
 */
export function IssueImportBanner({ token, handle, repoName, onProgress }: {
  token: string | null; handle: string; repoName: string; onProgress: () => void;
}) {
  const [state, setState] = useState<IssueImport | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { canAdmin } = useRepoPermission();
  const { toast } = useToast();
  const seen = useRef<number | null>(null);
  const progress = useRef(onProgress);
  progress.current = onProgress;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    getIssueImport(token, handle, repoName)
      .then(({ import: i }) => {
        if (!live) return;
        setState(i);
        // More issues, or just finished: the list behind this banner is out of date.
        const landed = i ? i.issues + (i.stage === "done" ? 1 : 0) : null;
        if (seen.current !== null && landed !== null && landed !== seen.current) progress.current();
        seen.current = landed;
        if (i && i.stage !== "done" && !i.error) timer = setTimeout(() => setTick((t) => t + 1), POLL_MS);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [token, handle, repoName, tick]);

  if (!state || state.stage === "done") return null;

  async function retry() {
    if (!token) return;
    setRetrying(true);
    try {
      await retryIssueImport(token, handle, repoName);
      setTick((t) => t + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't retry", { tone: "danger" });
    } finally {
      setRetrying(false);
    }
  }

  const from = state.source ? `github.com/${state.source}` : "GitHub";
  const tone = state.error ? "border-fh-danger-fg/30 bg-fh-danger-muted" : "border-fh-accent-emphasis/40 bg-fh-accent-subtle";
  return (
    <div role="status" className={`mb-4 flex flex-col gap-3 rounded-md border px-4 py-3 text-fh-sm text-fh-fg sm:flex-row sm:items-center ${tone}`}>
      <p className="min-w-0 flex-1">
        {state.error ? (
          <>Bringing the issues over from {from} stopped: {state.error} {importedSoFar(state)} came over before it stopped.</>
        ) : state.waitUntil ? (
          <>
            Paused until {clock(state.waitUntil)}: GitHub's requests for the hour are used up. It carries on by itself.{" "}
            {importedSoFar(state)} so far.
          </>
        ) : state.stage === "labels" || state.stage === "milestones" ? (
          <>Bringing the issues over from {from}: labels and milestones first.</>
        ) : (
          <>Bringing the issues over from {from}: {importedSoFar(state)} so far.</>
        )}
      </p>
      {state.error && canAdmin && token && (
        <Button size="sm" variant="default" loading={retrying} onClick={() => void retry()}>Retry</Button>
      )}
    </div>
  );
}
