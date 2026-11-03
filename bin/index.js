#!/usr/bin/env node
// Repo-level launcher. Runs the CLI package's bin so `bin/index.js` works from a checkout.
// The platform check lives in cli/bin/fcx.js, so both entry points enforce the same rules.
await import("../cli/bin/fcx.js");
