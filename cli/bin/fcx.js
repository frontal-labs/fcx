#!/usr/bin/env bun
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const cliPkg = require("@frontal-labs/fcx-cli/package.json");
const cliRoot = dirname(require.resolve("@frontal-labs/fcx-cli/package.json"));
const entry = join(cliRoot, cliPkg.main ?? "./src/index.ts");

process.argv.push(...process.argv.slice(2));

import(entry)
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
