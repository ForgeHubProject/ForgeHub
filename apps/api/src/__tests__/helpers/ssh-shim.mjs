#!/usr/bin/env node
// A minimal `ssh`-compatible client that git drives via GIT_SSH_COMMAND. This
// environment has no system `ssh` binary, so this ssh2-based shim stands in for
// the real end-to-end SSH transport test (issue #116). The SSH handshake, public-
// key auth, exec channel, and git pack exchange are all real — only the client
// executable is substituted.
//
// git invokes:  <shim> [-p PORT] [-o ...] user@host "<git-remote-command>"
// The remote command is always the final argv entry. Host/port fall back to env
// (FH_SSH_HOST / FH_SSH_PORT); the identity key comes from FH_SSH_KEY.
import { readFileSync } from "node:fs";
import ssh2 from "ssh2";

const args = process.argv.slice(2);
const command = args[args.length - 1];

let port = Number(process.env.FH_SSH_PORT) || 22;
let host = process.env.FH_SSH_HOST || "127.0.0.1";
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === "-p") {
    port = Number(args[i + 1]) || port;
    i++;
  } else if (args[i] === "-o") {
    i++; // skip option value (StrictHostKeyChecking, etc.)
  } else if (!args[i].startsWith("-")) {
    host = args[i].includes("@") ? args[i].split("@").pop() : args[i];
  }
}

const privateKey = readFileSync(process.env.FH_SSH_KEY);

const conn = new ssh2.Client();
conn
  .on("ready", () => {
    conn.exec(command, (err, stream) => {
      if (err) {
        process.stderr.write(String(err.message ?? err) + "\n");
        conn.end();
        process.exit(255);
        return;
      }
      let exitCode = 0;
      stream.on("exit", (code) => {
        if (typeof code === "number") exitCode = code;
      });
      stream.on("close", () => {
        conn.end();
        process.exit(exitCode);
      });
      process.stdin.pipe(stream);
      stream.pipe(process.stdout);
      stream.stderr.pipe(process.stderr);
    });
  })
  .on("error", (err) => {
    process.stderr.write("ssh-shim: " + String(err.message ?? err) + "\n");
    process.exit(255);
  })
  .connect({ host, port, username: "git", privateKey });
