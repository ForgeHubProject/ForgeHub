import { useEffect, useRef, useState } from "react";
import { avatarSrc, deleteAvatar, getPublicProfile, uploadAvatar } from "../api";
import { SettingsLayout } from "../components/SettingsLayout";
import type { PublicProfile, User } from "../types";
import { Avatar, Button, PageHeading, Skeleton, useToast } from "../ui";
import { ProfileForm } from "./ProfileForm";
import { useDocumentTitle } from "./useDocumentTitle";

type Props = { token: string; user: User; onLogout: () => void; onUserChange: (u: User) => void };

/** Settings → Public profile (#258): the profile's fields and picture. */
export function SettingsProfilePage({ token, user, onLogout, onUserChange }: Props) {
  useDocumentTitle("Your profile · Settings · ForgeHub");
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    getPublicProfile(token, user.handle).then(setProfile).catch(() => setProfile(null));
  }, [token, user.handle]);

  async function pickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !profile) return;
    setAvatarBusy(true);
    try {
      const { avatarKey } = await uploadAvatar(token, file);
      setProfile({ ...profile, avatarKey });
      onUserChange({ ...user, avatarKey });
      toast("Profile picture updated", { tone: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Upload failed", { tone: "danger" });
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatar() {
    if (!profile) return;
    setAvatarBusy(true);
    try {
      await deleteAvatar(token);
      setProfile({ ...profile, avatarKey: null });
      onUserChange({ ...user, avatarKey: null });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Remove failed", { tone: "danger" });
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <SettingsLayout token={token} user={user} onLogout={onLogout}>
      <PageHeading title="Public profile" divider />
      {!profile ? (
        <Skeleton width="100%" height={320} />
      ) : (
        <div className="flex flex-col-reverse gap-8 lg:flex-row">
          <div className="min-w-0 max-w-[560px] flex-1">
            <ProfileForm
              token={token}
              profile={profile}
              formId="settings-profile-form"
              onSaved={(p) => {
                setProfile(p);
                onUserChange({ ...user, displayName: p.displayName, bio: p.bio, location: p.location, website: p.website });
              }}
              footer={(saving) => (
                <div>
                  <Button type="submit" variant="primary" loading={saving}>Update profile</Button>
                </div>
              )}
            />
          </div>
          <div className="lg:w-56">
            <p className="mb-2 text-fh-sm font-semibold text-fh-fg">Profile picture</p>
            <Avatar name={profile.displayName || profile.handle} src={avatarSrc(profile.handle, profile.avatarKey)} size={200} className="max-w-full" />
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pickAvatar} />
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="default" loading={avatarBusy} onClick={() => fileRef.current?.click()}>
                {profile.avatarKey ? "Change" : "Upload"}
              </Button>
              {profile.avatarKey && (
                <Button size="sm" variant="invisible" disabled={avatarBusy} onClick={() => void removeAvatar()}>Remove</Button>
              )}
            </div>
          </div>
        </div>
      )}
    </SettingsLayout>
  );
}
