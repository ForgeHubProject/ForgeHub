import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { acceptTransfer, declineTransfer, listIncomingTransfers, type IncomingTransfer } from "../api";
import { expiresIn } from "../lib/expiresIn";
import { Badge, Button, useToast } from "../ui";

/**
 * Repositories people want to transfer to you (#256), each with Accept and
 * Decline. On your dashboard and your notifications, where the request's email
 * links; nothing shows when none is waiting.
 */
export function IncomingTransfers({ token }: { token: string }) {
  const [transfers, setTransfers] = useState<IncomingTransfer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    let live = true;
    listIncomingTransfers(token)
      .then((r) => { if (live) setTransfers(r.transfers); })
      .catch(() => {});
    return () => { live = false; };
  }, [token]);

  if (transfers.length === 0) return null;

  async function answer(t: IncomingTransfer, accept: boolean) {
    setBusy(t.id);
    try {
      if (accept) {
        const { fullName } = await acceptTransfer(token, t.id);
        toast(`${fullName} is yours now`, { tone: "success" });
        navigate(`/${fullName}`);
        return;
      }
      await declineTransfer(token, t.id);
      toast(`Declined ${t.repoFullName}`, { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", { tone: "danger" });
    }
    // Answered, expired or gone: either way it's no longer waiting for you.
    setTransfers((list) => list.filter((x) => x.id !== t.id));
    setBusy(null);
  }

  return (
    <section aria-label="Repository transfers" className="mb-5 rounded-md border border-fh-accent-emphasis/40 bg-fh-accent-subtle">
      {transfers.map((t, i) => (
        <div key={t.id} className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center ${i > 0 ? "border-t border-fh-accent-emphasis/20" : ""}`}>
          <div className="min-w-0 flex-1 text-fh-sm text-fh-fg">
            <p className="break-words">
              <span className="font-semibold">@{t.from}</span> wants to transfer{" "}
              <span className="font-semibold">{t.repoFullName}</span> to you.{" "}
              {t.visibility === "private" && <Badge tone="neutral" variant="outline">Private</Badge>}
            </p>
            <p className="mt-0.5 text-fh-xs text-fh-fg-muted">
              {t.description ? <>{t.description} · </> : null}Expires {expiresIn(t.expiresAt)}.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="primary" loading={busy === t.id} disabled={busy !== null} onClick={() => void answer(t, true)}>
              Accept
            </Button>
            <Button size="sm" variant="default" disabled={busy !== null} onClick={() => void answer(t, false)}>
              Decline
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
