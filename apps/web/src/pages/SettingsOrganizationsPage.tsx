import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMyOrgs, setOrgMembershipVisibility } from "../api";
import { SettingsLayout } from "../components/SettingsLayout";
import type { Organization, User } from "../types";
import { Avatar, Badge, Button, EmptyState, PageHeading, Skeleton, useToast } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

/**
 * Settings → Organizations (#257): the organizations you belong to, and which
 * of them show on your profile. Memberships stay private until you choose.
 */
export function SettingsOrganizationsPage({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  useDocumentTitle("Organizations · Settings · ForgeHub");
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    getMyOrgs(token).then((d) => setOrgs(d.orgs)).catch(() => setOrgs([]));
  }, [token]);

  async function toggle(org: Organization) {
    const next = !org.publicMember;
    setOrgs((prev) => (prev ?? []).map((o) => (o.id === org.id ? { ...o, publicMember: next } : o)));
    try {
      await setOrgMembershipVisibility(token, org.handle, next);
    } catch (err) {
      setOrgs((prev) => (prev ?? []).map((o) => (o.id === org.id ? { ...o, publicMember: !next } : o)));
      toast(err instanceof Error ? err.message : "Couldn't change it", { tone: "danger" });
    }
  }

  return (
    <SettingsLayout token={token} user={user} onLogout={onLogout}>
      <PageHeading title="Organizations" description="Organizations you belong to. A public membership shows on your profile." divider />
      {orgs === null ? (
        <Skeleton width="100%" height={72} />
      ) : orgs.length === 0 ? (
        <EmptyState bordered title="You're not in any organizations" actions={<Link to="/organizations/new"><Button variant="default">New organization</Button></Link>} />
      ) : (
        <ul className="divide-y divide-fh-border-muted rounded-md border border-fh-border bg-fh-surface">
          {orgs.map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={o.displayName || o.handle} size={32} square />
              <div className="min-w-0 flex-1">
                <Link to={`/${o.handle}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">{o.handle}</Link>
                <p className="text-fh-xs text-fh-fg-muted">{o.viewerRole === "OWNER" ? "Owner" : "Member"}</p>
              </div>
              <Badge variant="outline" tone={o.publicMember ? "success" : "neutral"}>{o.publicMember ? "Public" : "Private"}</Badge>
              <Button size="sm" variant="default" onClick={() => void toggle(o)}>
                {o.publicMember ? "Make private" : "Make public"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsLayout>
  );
}
