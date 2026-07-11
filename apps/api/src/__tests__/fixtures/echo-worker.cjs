"use strict";
// Test fixture: a stand-in for the real wasm worker. Posts "ready", then
// answers each diff message with a canned StructuredDiff (echoing byte lengths
// so tests can confirm the payload made the round trip). No real wasm involved.
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "diff") return;
  const raw = JSON.stringify({
    version: "1.0",
    format: "gltf-scene",
    changes: [{ path: "echo", kind: "modified", before: msg.base.length, after: msg.head.length }],
  });
  parentPort.postMessage({ type: "result", id: msg.id, raw });
});
parentPort.postMessage({ type: "ready" });
