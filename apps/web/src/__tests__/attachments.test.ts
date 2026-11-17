import { describe, it, expect, vi, afterEach } from "vitest";
import { attachmentObjectUrl, holdAttachmentImages, isAttachmentUrl } from "../lib/attachments";

const base = "https://forge.example/attachments/";
const id = "0123456789abcdef0123456789abcdef";

afterEach(() => vi.unstubAllGlobals());

describe("comment attachments (#253)", () => {
  it("knows an attachment URL by its base and id only", () => {
    expect(isAttachmentUrl(base + id, base)).toBe(true);
    expect(isAttachmentUrl(`${base}${id}?x=1`, base)).toBe(false);
    expect(isAttachmentUrl(`https://evil.example/attachments/${id}`, base)).toBe(false);
    expect(isAttachmentUrl(`${base}../users/me`, base)).toBe(false);
  });

  it("holds back attachment images for the token-carrying fetch, and leaves other images alone", () => {
    const html = `<p><img src="${base}${id}" alt="shot.png"><img src="https://cdn.example/x.png" alt="x"></p>`;
    expect(holdAttachmentImages(html, base)).toBe(
      `<p><img data-fh-attachment="${base}${id}" alt="shot.png"><img src="https://cdn.example/x.png" alt="x"></p>`,
    );
  });

  it("never sends the token to a URL a comment put in data-fh-attachment itself", async () => {
    vi.stubGlobal("window", { location: { origin: "https://forge.example" } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(attachmentObjectUrl(`https://evil.example/attachments/${id}`, "tok")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
