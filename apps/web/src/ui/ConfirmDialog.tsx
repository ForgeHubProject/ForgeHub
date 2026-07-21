import { Dialog } from "./Dialog";
import { Button } from "./Button";

type Props = {
  open?: boolean;
  title: string;
  message: React.ReactNode;
  /** Optional emphasized warning callout under the message. */
  warning?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Confirm button intent — "danger" for destructive actions. */
  tone?: "primary" | "danger";
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A confirmation modal built on `Dialog`. Kept as a thin wrapper so existing
 * `<ConfirmDialog .../>` call sites keep working while gaining focus handling,
 * theming, and Escape/backdrop dismissal for free.
 */
export function ConfirmDialog({
  open = true,
  title,
  message,
  warning,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  tone = "danger",
  loading = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="default" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-fh-base text-fh-fg leading-normal">{message}</p>
      {warning && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-fh-warning-emphasis/30 bg-fh-warning-muted px-3 py-2 text-fh-sm text-fh-warning-fg">
          <span aria-hidden className="mt-px font-bold">!</span>
          <span>{warning}</span>
        </div>
      )}
    </Dialog>
  );
}
