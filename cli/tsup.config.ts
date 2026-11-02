import { defineConfig } from "tsup";

// Single ESM bundle (plan §15.2 item 1). Workspace packages are inlined so the
// published binary needs no TypeScript runtime; ggml-node stays external because
// it ships native code.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  noExternal: [/^@fcx\//],
  external: ["ggml-node", "typescript", "zod"],
  // Bundled CommonJS dependencies (vscode-jsonrpc) call require() for Node builtins. In an ESM bundle
  // that require is missing, so give the bundle a real one.
  banner: {
    js: 'import { createRequire as __fcxCreateRequire } from "node:module"; const require = __fcxCreateRequire(import.meta.url);',
  },
});
