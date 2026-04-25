type Props = {
  title: string;
  message: string;
  warning?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ title, message, warning, confirmLabel = "Delete", onConfirm, onCancel }: Props) {
  return (
    <div style={styles.backdrop} onClick={onCancel}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 style={styles.title}>{title}</h3>
        <p style={styles.message}>{message}</p>
        {warning && (
          <div style={styles.warningBox}>
            <span style={styles.warningIcon}>⚠</span>
            {warning}
          </div>
        )}
        <div style={styles.actions}>
          <button onClick={onCancel} style={styles.cancelBtn}>Cancel</button>
          <button onClick={onConfirm} style={styles.deleteBtn}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
  },
  dialog: {
    backgroundColor: "#fff", borderRadius: 10, padding: "24px 28px",
    width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  },
  title: { fontSize: 16, fontWeight: 700, color: "#111827", margin: "0 0 8px" },
  message: { fontSize: 14, color: "#374151", margin: "0 0 12px", lineHeight: 1.5 },
  warningBox: {
    display: "flex", alignItems: "flex-start", gap: 8,
    backgroundColor: "#fef9c3", border: "1px solid #fde047",
    borderRadius: 6, padding: "10px 12px",
    fontSize: 13, color: "#713f12", lineHeight: 1.5, marginBottom: 16,
  },
  warningIcon: { fontSize: 14, flexShrink: 0, marginTop: 1 },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  cancelBtn: {
    padding: "8px 16px", fontSize: 13, color: "#6b7280",
    background: "transparent", border: "1px solid #e5e7eb",
    borderRadius: 6, cursor: "pointer",
  },
  deleteBtn: {
    padding: "8px 16px", fontSize: 13, fontWeight: 600,
    color: "#fff", backgroundColor: "#ef4444",
    border: "none", borderRadius: 6, cursor: "pointer",
  },
};
