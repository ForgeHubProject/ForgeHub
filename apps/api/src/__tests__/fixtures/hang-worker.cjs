"use strict";
// Test fixture: reports ready, then never answers a diff — simulating a wasm
// call that hangs, so the main thread's timeout + terminate path is exercised.
const { parentPort } = require("node:worker_threads");
parentPort.on("message", () => { /* intentionally never responds */ });
parentPort.postMessage({ type: "ready" });
