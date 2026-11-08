import { useEffect, useState } from "react";
import { getNotificationPrefs, setNotificationPrefs } from "../api";
import { SettingsLayout } from "../components/SettingsLayout";
import type { NotificationPrefs, NotificationReasonKey, User } from "../types";
import { PageHeading, Skeleton, useToast } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

const ROWS: Array<{ reason: NotificationReasonKey; label: string; hint: string }> = [
  { reason: "SUBSCRIBED", label: "Watching", hint: "Activity in repositories you watch." },
  { reason: "COMMENT", label: "Participating", hint: "New comments in conversations you're part of." },
  { reason: "MENTIONED", label: "@mentions", hint: "Someone mentions you." },
  { reason: "ASSIGNED", label: "Assigned", hint: "An issue or pull request is assigned to you." },
  { reason: "REVIEW_REQUESTED", label: "Review requests", hint: "Someone asks you to review a pull request." },
];

/** Settings → Notifications (#258): what reaches your inbox and your email, per reason. */
export function SettingsNotificationsPage({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  useDocumentTitle("Notifications · Settings · ForgeHub");
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    getNotificationPrefs(token).then(setPrefs).catch(() => setPrefs(null));
  }, [token]);

  async function save(patch: Parameters<typeof setNotificationPrefs>[1], optimistic: NotificationPrefs) {
    const before = prefs;
    setPrefs(optimistic);
    try {
      setPrefs(await setNotificationPrefs(token, patch));
    } catch (err) {
      setPrefs(before);
      toast(err instanceof Error ? err.message : "Couldn't save", { tone: "danger" });
    }
  }

  return (
    <SettingsLayout token={token} user={user} onLogout={onLogout}>
      <PageHeading title="Notifications" divider />
      {!prefs ? (
        <Skeleton width="100%" height={240} />
      ) : (
        <>
          <label className="mb-6 flex items-start gap-3 rounded-md border border-fh-border bg-fh-surface p-4">
            <input
              type="checkbox"
              className="mt-1"
              checked={prefs.emailNotifications}
              onChange={(e) => void save({ emailNotifications: e.target.checked }, { ...prefs, emailNotifications: e.target.checked })}
            />
            <span>
              <span className="block text-fh-base font-semibold text-fh-fg">Email notifications</span>
              <span className="text-fh-sm text-fh-fg-muted">
                Send notifications to {user.email}. The Email column below picks which ones.
              </span>
            </span>
          </label>

          <table className="w-full overflow-hidden rounded-md border border-fh-border bg-fh-surface text-fh-sm">
            <thead className="bg-fh-canvas text-left text-fh-fg-muted">
              <tr>
                <th className="px-4 py-2 font-semibold">Notify me about</th>
                <th className="w-28 px-4 py-2 text-center font-semibold">On ForgeHub</th>
                <th className="w-28 px-4 py-2 text-center font-semibold">Email</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-fh-border-muted">
              {ROWS.map((row) => {
                const value = prefs.reasons[row.reason];
                const toggle = (k: "web" | "email", on: boolean) =>
                  void save({ reasons: { [row.reason]: { [k]: on } } }, { ...prefs, reasons: { ...prefs.reasons, [row.reason]: { ...value, [k]: on } } });
                return (
                  <tr key={row.reason}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-fh-fg">{row.label}</p>
                      <p className="text-fh-fg-muted">{row.hint}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <input type="checkbox" aria-label={`${row.label} on ForgeHub`} checked={value.web} onChange={(e) => toggle("web", e.target.checked)} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${row.label} by email`}
                        checked={value.email && prefs.emailNotifications}
                        disabled={!prefs.emailNotifications}
                        onChange={(e) => toggle("email", e.target.checked)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </SettingsLayout>
  );
}
