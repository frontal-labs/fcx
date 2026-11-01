# Decisions

Track resolved assumptions here.

## V1 — project.json precedence
**Status:** Verified by implementation choice  
**Resolution:** First-found wins. `resolveConfig()` checks `$FRONTAL_CODE_CONFIG_HOME/project.json`, then `$FRONTAL_CODE_HOME/project.json`, then `~/.frontal-code/project.json`, then `config/project.json`, returning the first valid file found.  
**Evidence:** `packages/config/src/index.ts` `findProjectConfig()` iterates locations in order and returns on first match.

## V2 — settings merge semantics and permission_mode precedence
**Status:** Verified by implementation choice  
**Resolution:** Merge order is user → project → local, with project/local trust filtering. `permission_mode` precedence: CLI flag → `RUSTY_CLAUDE_PERMISSION_MODE` env → settings files → `project.json` `runtime.permission_mode` → built-in default `prompt`. Policy ceiling applied last.  
**Evidence:** `packages/config/src/index.ts` `mergeSettings()` and `resolvePermissionMode()`.

## V3 — unknown keys rejection
**Status:** Assumed (not verified against Frontal Code source)  
**Resolution:** Store fc settings in a separate namespace (`fc` object in settings.json). If Frontal Code rejects unknown keys, fallback to `/fc.json` and `.frontal-code/fc.json` (§5.4 V3 fallback).  
**Evidence:** Decision recorded; implementation uses `settings.fc` namespace which is forward-compatible.

## V4 — `frontal-code status --output-format json`
**Status:** Not verified (no `frontal-code` binary available locally)  
**Resolution:** Parity tests compare against hand-written expected outputs in `fixtures/config/cases/*/expected.json`.  
**Evidence:** 30 fixture cases created with hand-written expected outputs.

## V5 — ggml-node model cache directory
**Status:** Verified from ggml-node types  
**Resolution:** `GgmlNodeOptions.cacheDir` supports configuration; defaults to env `GGML_NODE_CACHE_DIR` or OS cache dir + `/ggml-node`.  
**Evidence:** `node_modules/ggml-node/dist/types-Dt0G8W03.d.ts` — `cacheDir?: string` with comment "Default: env GGML_NODE_CACHE_DIR, else the OS cache dir + /ggml-node."

## V6 — ggml-node tokenization / token counting
**Status:** Verified from ggml-node types  
**Resolution:** `GgmlNode.countTokens(text: string) => Promise<number>` is available. `fc` uses approximation `ceil(chars / 3.5)` until exact counting is integrated.  
**Evidence:** `node_modules/ggml-node/dist/types-Dt0G8W03.d.ts` — `countTokens: (text: string) => Promise<number>`.

## V7 — ggml-node streaming, temperature, stop, prompt-prefix cache
**Status:** Verified from ggml-node types  
**Resolution:** `generate` supports `temperature`, `stop`, `signal`; `stream()` returns `StreamResult` with `textStream`. Prompt-prefix cache reuse handled internally by ggml-node.  
**Evidence:** `node_modules/ggml-node/dist/types-Dt0G8W03.d.ts` — `GenerateOptions.temperature`, `stop`, `signal`; `stream()` method.

## V8 — ggml-node LoRA adapters at load time
**Status:** Not verified (no adapter support in ggml-node v0.2.0 API)  
**Resolution:** Ship merged fine-tuned GGUFs (default plan per §13.4).  
**Evidence:** `GgmlNodeOptions` has no `lora` or `adapter` field; merged GGUFs are the default.

## V9 — ggml-node process isolation API
**Status:** Verified from ggml-node types  
**Resolution:** `GgmlNodeOptions.isolation: "none" | "process"` supports process isolation. `fc` uses `"none"` for in-process model hosting; worker isolation implemented at the `fc` level via `ModelWorker`.  
**Evidence:** `node_modules/ggml-node/dist/types-Dt0G8W03.d.ts` — `isolation?: "none" | "process"`.

## V10 — ACP TypeScript SDK
**Status:** Not verified (no ACP SDK package checked)  
**Resolution:** Implement JSON-RPC over stdio directly per the ACP spec V10, as fallback per the spec.  
**Evidence:** No `@modelcontextprotocol/sdk` or ACP-specific package found in `node_modules`; `packages/acp` is a stub awaiting implementation.

## V11 — SQLite FTS5 and sqlite-vec
**Status:** Not verified (no SQLite binding evaluated yet)  
**Resolution:** Fall back to in-memory brute-force cosine search over int8-quantized vectors if FTS5/vec not available.  
**Evidence:** `packages/index` is a stub; no SQLite dependency added yet.

## V12 — ggml-node failing CI on main
**Status:** Not verified (no access to `frontal-labs/ggml-node` repo)  
**Resolution:** Recorded as blocker; `ggml-node@0.2.0` is installed and functional for development.  
**Evidence:** `ggml-node@0.2.0` installed via bun; `packages/model` builds and typechecks against it.

## Additional decisions

### Binary name (Decision 0, §18)
**Status:** Pending user input  
**Resolution:** Binary shipped as `fcx` (per `meta.ts`), npm package `@frontal-labs/fc`. One-line change in `meta.ts` to rename.  
**Evidence:** `packages/cli/src/meta.ts` sets `binary: "fcx"`.

### Model selection (Decision 3, §18)
**Status:** Pending M1 evaluation  
**Resolution:** M0 baseline uses `qwen2.5-1.5b` from ggml-node registry.  
**Evidence:** `packages/model/src/registry.ts` `DEFAULT_MODELS`.

### Warm background process (Decision 7, §18)
**Status:** Pending user confirmation  
**Resolution:** Warm process enabled by default; `fc.warmServer: false` disables it.  
**Evidence:** Not yet implemented; `packages/cli` stub supports it via future work.
