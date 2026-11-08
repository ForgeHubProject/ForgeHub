import { useState } from "react";
import { updateMyProfile } from "../api";
import type { PublicProfile } from "../types";
import { Field, Select, TextInput, Textarea, useToast } from "../ui";

/**
 * The public profile's fields (#257/#258): the "Edit profile" dialog and the
 * Public profile settings page both render this. Submit it with a button that
 * names `formId`.
 */
export function ProfileForm({
  token,
  profile,
  formId,
  onSaved,
  onSavingChange,
  footer,
}: {
  token: string;
  profile: PublicProfile;
  formId: string;
  onSaved: (updated: PublicProfile) => void;
  onSavingChange?: (saving: boolean) => void;
  /** Rendered at the end of the form, e.g. a submit button. */
  footer?: (saving: boolean) => React.ReactNode;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [bio, setBio] = useState(profile.bio ?? "");
  const [location, setLocation] = useState(profile.location ?? "");
  const [website, setWebsite] = useState(profile.website ?? "");
  // Profile (#257).
  const [pronouns, setPronouns] = useState(profile.pronouns ?? "");
  const [company, setCompany] = useState(profile.company ?? "");
  const [links, setLinks] = useState<string[]>([0, 1, 2, 3].map((i) => profile.socialLinks?.[i] ?? ""));
  const [statusEmoji, setStatusEmoji] = useState(profile.status?.emoji ?? "");
  const [statusText, setStatusText] = useState(profile.status?.text ?? "");
  const [statusFor, setStatusFor] = useState("never");
  const [privateProfile, setPrivateProfile] = useState(!!profile.privateProfile);
  const [saving, setSavingState] = useState(false);
  const setSaving = (v: boolean) => {
    setSavingState(v);
    onSavingChange?.(v);
  };
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const hours = ({ never: 0, day: 24, week: 24 * 7 } as Record<string, number>)[statusFor] ?? 0;
      const res = await updateMyProfile(token, {
        displayName, bio, location, website, pronouns, company, privateProfile,
        socialLinks: links.map((l) => l.trim()).filter(Boolean),
        status: statusEmoji.trim() || statusText.trim()
          ? { emoji: statusEmoji, text: statusText, expiresAt: hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null }
          : null,
      });
      onSaved({ ...profile, ...res.user });
      toast("Profile updated", { tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form id={formId} onSubmit={save} className="flex flex-col gap-4">
      <Field label="Name" htmlFor="edit-name">
        {(id) => (
          <TextInput
            id={id}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your display name"
            maxLength={64}
          />
        )}
      </Field>
      <Field label="Bio" htmlFor="edit-bio" hint={`${bio.length}/200`}>
        {(id) => (
          <Textarea
            id={id}
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Tell people a little about yourself"
            maxLength={200}
          />
        )}
      </Field>
      <Field label="Location" htmlFor="edit-location">
        {(id) => (
          <TextInput
            id={id}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="City, Country"
            maxLength={100}
          />
        )}
      </Field>
      <Field label="Website" htmlFor="edit-website">
        {(id) => (
          <TextInput
            id={id}
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://yoursite.com"
            maxLength={200}
          />
        )}
      </Field>
      <Field label="Pronouns" htmlFor="edit-pronouns">
        {(id) => <TextInput id={id} value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="they/them" maxLength={30} />}
      </Field>
      <Field label="Company" htmlFor="edit-company">
        {(id) => <TextInput id={id} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Where you work" maxLength={100} />}
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-fh-sm font-semibold text-fh-fg">Social accounts</legend>
        {links.map((l, i) => (
          <TextInput
            key={i}
            aria-label={`Social account ${i + 1}`}
            type="url"
            value={l}
            onChange={(e) => setLinks((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder="https://…"
            maxLength={200}
          />
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-fh-sm font-semibold text-fh-fg">Status</legend>
        <div className="flex gap-2">
          <TextInput aria-label="Status emoji" value={statusEmoji} onChange={(e) => setStatusEmoji(e.target.value)} placeholder="🙂" maxLength={16} className="w-16 text-center" />
          <TextInput aria-label="Status" value={statusText} onChange={(e) => setStatusText(e.target.value)} placeholder="What's happening?" maxLength={80} />
        </div>
        <Select aria-label="Clear status after" value={statusFor} onChange={(e) => setStatusFor(e.target.value)}>
          <option value="never">Don't clear</option>
          <option value="day">Clear after a day</option>
          <option value="week">Clear after a week</option>
        </Select>
      </fieldset>
      <label className="flex items-start gap-2 text-fh-sm text-fh-fg">
        <input type="checkbox" className="mt-0.5" checked={privateProfile} onChange={(e) => setPrivateProfile(e.target.checked)} />
        <span>
          <span className="font-semibold">Private profile</span>
          <span className="block text-fh-fg-muted">Hide your activity, stars, followers and status from everyone else.</span>
        </span>
      </label>
      {error && (
        <p className="rounded-md bg-fh-danger-muted px-3 py-2 text-fh-sm text-fh-danger-fg">{error}</p>
      )}
      {footer?.(saving)}
    </form>
  );
}
