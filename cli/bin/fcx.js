#!/usr/bin/env node
// Entry point for the published binary. Refuses platforms ggml-node does not support, then runs the compiled CLI in dist/.
import { arch, exit, platform, stderr } from "node:process";

// ggml-node ships native code for these. Anything else has no backend to load.
const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"];
const SUPPORTED_ARCHES = ["arm64", "x64"];

if (!SUPPORTED_PLATFORMS.includes(platform) || !SUPPORTED_ARCHES.includes(arch)) {
  stderr.write(
    `fcx: unsupported platform ${platform}-${arch}. Supported: ${SUPPORTED_PLATFORMS.join(", ")} on ${SUPPORTED_ARCHES.join(", ")}.\n`,
  );
  exit(1);
}

await import("../dist/main.js");
