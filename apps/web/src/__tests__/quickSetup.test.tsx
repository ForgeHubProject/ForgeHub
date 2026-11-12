/**
 * An empty repository shows how to push its first commit (GitHub's quick
 * setup) to people who can push, and only that it's empty to everyone else.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuickSetup } from "../pages/repo/QuickSetup";

vi.mock("../ui", async (orig) => ({ ...(await orig<typeof import("../ui")>()), useToast: () => ({ toast: () => {} }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const render = (props: Partial<Parameters<typeof QuickSetup>[0]>) => {
  vi.stubGlobal("window", { location: { origin: "https://forgehubcode.com", hostname: "forgehubcode.com" } });
  return renderToStaticMarkup(<QuickSetup handle="gamedev" repoName="lanternfall" defaultBranch="main" canPush {...props} />)
    .replace(/&quot;/g, '"');
};

describe("QuickSetup", () => {
  it("gives a pusher the clone URL and the first-push commands", () => {
    const html = render({});
    // The HTTPS URL is the API's (VITE_API_URL, or the page's origin when empty).
    const url = /(https?:\/\/[^\s<"]+\/git\/gamedev\/lanternfall\.git)/.exec(html)?.[1];
    expect(url).toBeTruthy();
    expect(html).toContain('echo "# lanternfall" &gt;&gt; README.md');
    expect(html).toContain(`git remote add origin ${url}`);
    expect(html).toContain("git push -u origin main");
  });

  it("starts on SSH when the server offers it", () => {
    expect(render({ sshPort: 22 })).toContain("git remote add origin git@forgehubcode.com:gamedev/lanternfall.git");
  });

  it("tells everyone else it's empty, with no commands", () => {
    const html = render({ canPush: false });
    expect(html).toContain("This repository is empty");
    expect(html).not.toContain("git push");
  });
});
