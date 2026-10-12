/**
 * Write and admin gates come from the server's `viewerPermission` (#218), never
 * from comparing the viewer's handle with the URL's: on an org repo the URL
 * handle is the org's, and a write collaborator's never matches.
 */
import { describe, it, expect } from "vitest";
import { repoPermission } from "../pages/repo/permission";

describe("repoPermission", () => {
  it("admin may write and administer", () => {
    expect(repoPermission("admin")).toEqual({ canWrite: true, canAdmin: true });
  });

  it("write may write but not administer", () => {
    expect(repoPermission("write")).toEqual({ canWrite: true, canAdmin: false });
  });

  it("read, signed out (null) and an older API without the field (undefined) may do neither", () => {
    for (const p of ["read", null, undefined] as const) {
      expect(repoPermission(p)).toEqual({ canWrite: false, canAdmin: false });
    }
  });
});
