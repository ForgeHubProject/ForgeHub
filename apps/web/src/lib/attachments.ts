import { API_BASE } from "../api";

/**
 * Comment attachments (#253) live on the API at `/attachments/<id>`. A private
 * repository's need the signed-in token, which an `<img>` or a link can't send,
 * so the renderer fetches them itself, and sends the token to these URLs only.
 */
export function attachmentBase(): string {
  return new URL(`${API_BASE}/attachments/`, window.location.origin).href;
}

export function isAttachmentUrl(href: string, base = attachmentBase()): boolean {
  return href.startsWith(base) && /^[0-9a-f]{32}$/.test(href.slice(base.length));
}

/** The signed-in token, where App keeps it: the renderer is used in places that aren't passed one. */
export function storedToken(): string | null {
  try {
    return localStorage.getItem("fh_token");
  } catch {
    return null;
  }
}

/** Attachment images keep their URL aside (no request goes out without the token) until the renderer loads them. */
export function holdAttachmentImages(html: string, base = attachmentBase()): string {
  return html.replace(/<img src="([^"]*)"/g, (tag, src: string) => (isAttachmentUrl(src, base) ? `<img data-fh-attachment="${src}"` : tag));
}

async function fetchAttachment(url: string, token: string): Promise<Response> {
  // A comment can carry its own data-fh-attachment (DOMPurify keeps data-*): the token goes nowhere else (#253).
  if (!isAttachmentUrl(url)) throw new Error("Not an attachment URL");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// shortcut: object URLs live as long as the tab; revoke them if long sessions show memory growth.
const objectUrls = new Map<string, Promise<string>>();

/** An attachment fetched with the token, as an object URL an `<img>` can show. */
export function attachmentObjectUrl(url: string, token: string): Promise<string> {
  const key = `${token} ${url}`;
  let loaded = objectUrls.get(key);
  if (!loaded) {
    loaded = fetchAttachment(url, token).then(async (res) => URL.createObjectURL(await res.blob()));
    loaded.catch(() => objectUrls.delete(key));
    objectUrls.set(key, loaded);
  }
  return loaded;
}

/** Save an attachment fetched with the token, under the name the server gives it. */
export async function downloadAttachment(url: string, token: string): Promise<void> {
  const res = await fetchAttachment(url, token);
  const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = name ? decodeURIComponent(name) : "attachment";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
