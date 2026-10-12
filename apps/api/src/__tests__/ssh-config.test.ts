import { describe, it, expect } from "vitest";
import { sshClientConfig } from "../ssh/config.js";

describe("sshClientConfig", () => {
  it("is off when no listening port is set", () => {
    expect(sshClientConfig({})).toEqual({ sshEnabled: false, sshPort: null, sshHost: null });
    expect(sshClientConfig({ FORGEHUB_SSH_PUBLIC_PORT: "22" }).sshEnabled).toBe(false);
  });

  it("tells clients the listening port by default", () => {
    expect(sshClientConfig({ FORGEHUB_SSH_PORT: "2222" })).toEqual({ sshEnabled: true, sshPort: 2222, sshHost: null });
  });

  it("tells clients the public port when something forwards to the listener", () => {
    expect(sshClientConfig({ FORGEHUB_SSH_PORT: "2222", FORGEHUB_SSH_PUBLIC_PORT: "22" }).sshPort).toBe(22);
  });

  it("ignores an invalid public port and an invalid listening port", () => {
    expect(sshClientConfig({ FORGEHUB_SSH_PORT: "2222", FORGEHUB_SSH_PUBLIC_PORT: "x" }).sshPort).toBe(2222);
    expect(sshClientConfig({ FORGEHUB_SSH_PORT: "70000" }).sshEnabled).toBe(false);
  });

  it("passes the host override through", () => {
    expect(sshClientConfig({ FORGEHUB_SSH_PORT: "2222", FORGEHUB_SSH_HOST: " git.example.com " }).sshHost).toBe("git.example.com");
  });
});
