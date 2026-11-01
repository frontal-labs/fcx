#!/usr/bin/env node
const { createRequire } = require("node:module");
const createRequireFn = createRequire(module.url);
const { dirname, join } = require("node:path");
const { fileURLToPath } = require("node:url");

const __dirname = dirname(fileURLToPath(module.url));

const cliPkg = createRequireFn("@frontal-labs/fcx-cli/package.json");
const cliRoot = dirname(createRequireFn.resolve("@frontal-labs/fcx-cli/package.json"));
const entry = join(cliRoot, cliPkg.main ?? "./src/index.ts");

createRequireFn(entry);
