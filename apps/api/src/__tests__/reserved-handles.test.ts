import { describe, it, expect } from "vitest";
import { handleSchema, newHandleSchema } from "../validation.js";

describe("newHandleSchema", () => {
  it("refuses names that are the site's own pages, in any case (#255)", () => {
    for (const h of ["issues", "Pulls", "explore", "settings"]) {
      expect(newHandleSchema.safeParse(h).success).toBe(false);
    }
  });

  it("only binds new accounts: signing in or naming an existing user still takes any handle", () => {
    expect(handleSchema.safeParse("issues").success).toBe(true);
  });

  it("still takes ordinary names, including ones that merely start like a page", () => {
    for (const h of ["ada", "issues-bot", "pullsy", "copy-tester"]) {
      expect(newHandleSchema.safeParse(h).success).toBe(true);
    }
  });
});
