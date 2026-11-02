# Decisions

Track resolved assumptions here.

## 2026-11-01 — Config resolution (V2/V3, §5.1–§5.3)

Resolved during implementation of `packages/config` and the 30-case parity suite
(`fixtures/config/cases/`):

- **User settings location:** read from `${configHome}/settings.json` (not the
  hardcoded `~/.frontal-code/settings.json`), where `configHome` is the resolved
  `$FRONTAL_CODE_CONFIG_HOME` / `$FRONTAL_CODE_HOME` / `~/.frontal-code`.
- **Project/local settings location:** resolved relative to the workspace cwd
  via `resolvePath(cwd, path)` (`.frontal-code/settings.json`,
  `.frontal-code/settings.local.json`).
- **Warning sources:** absolute file paths (matching the parity fixtures).
- **Untrusted workspace withholding (§5.1):** `hooks`, `mcpServers`, `plugins`,
  `enabledPlugins`, `sandbox`, `permissionMode`, `permissions.defaultMode` are
  dropped from project/local settings with one warning per key. `permissions.allow`
  is always ignored with a warning. `permissions.ask` / `permissions.deny` still
  apply.
- **Permission mode precedence (§5.2):** CLI flag → `RUSTY_CLAUDE_PERMISSION_MODE`
  → settings files → `project.json` `runtime.permission_mode` → built-in default
  `prompt`, then `policy.permissionCeiling` caps it. Unrecognized values ignored.
- **Effective policy (§3.2):** intersection of `projectConfig.policy` and every
  settings file's policy. `settings.policy` in the output reflects user settings
  only; project/local policy is folded into the intersection, not the output.
- **Warning ordering:** withheld-key warnings emitted in the settings file's key
  insertion order; `permissions.allow` warnings are deferred to the end.

Fixture corrections made to align `expected.json` with the plan:
- `003`, `012`, `021`: `permissionMode` from an untrusted project setting is now
  withheld with a warning (previously wrongly applied without warning).
- `005`: `projectConfig` corrected to the actual `home/project.json` content.
- `006`: `permissionMode` corrected to `prompt` and `projectConfig` to `{}`
  (the source `home/project.json` is `{}`).
- `004`: warning ordering corrected per the rule above.

All 30 parity cases pass; lint, typecheck, and the full test suite are green.

## 2026-11-01 — M0 verification results (V1–V14, §3.3)

Checked by reading `frontal-labs/code` @ `7d44a2fe` and `frontal-labs/ggml-node` @ `5bd1938b`
(not built or run). Several answers contradict the spec:

| ID | Verdict | Evidence |
|---|---|---|
| V1 | CONTRADICTED | Config loader is first-found-wins for one `project.json` (`crates/code-core/src/config.rs:225-268`), not a merge. |
| V2 | CONTRADICTED | Settings merge lives in `crates/code-runtime/src/config.rs` (`discover`, `load`). Effective mode is the minimum across sources. No `RUSTY_CLAUDE_PERMISSION_MODE` in `crates/`. `project.json` `runtime.permission_mode` is never read by `ConfigurationManager`. Workspace root is `cwd`, not a `.frontal-code`/`.git` walk-up. Crate names are `code-core`/`code-runtime`. |
| V3 | CONTRADICTED | No `deny_unknown_fields`; unknown keys are silently ignored. |
| V4 | NOT_DETERMINABLE | No CLI `status --output-format json` found; `status` is a slash command. Not built. |
| V5 | VERIFIED | `GGML_NODE_CACHE_DIR` and `cacheDir` option (`docs/CONFIGURATION.md`, `API.md`). |
| V6 | VERIFIED | `countTokens(text)` in `docs/API.md`. |
| V7 | PARTIAL | Streaming, temperature and stop sequences exist. No prefix/KV reuse across calls. |
| V8 | CONTRADICTED | No LoRA/adapter support in ggml-node. node-llama-cpp has LoRA options, which ggml-node does not expose. Ship merged GGUFs (§13.4). |
| V9 | VERIFIED (caveat) | Option `isolation: "process"` on `createGgmlNode` (`docs/ISOLATION.md`). |
| V10 | PARTIAL | Official package `@agentclientprotocol/sdk` 2.2.0 (2026-10-30). Spec version not confirmed. |
| V11 | PARTIAL | better-sqlite3 builds with FTS5. sqlite-vec has darwin-arm64 and linux x64/arm64 optional packages. Not compiled. |
| V12 | VERIFIED | ggml-node `CI` on main passes. `Release` workflow fails (job `release`). |
| V13 | VERIFIED (runtime) | `module.enableCompileCache` exists on Node v22.23.3. Startup benchmark not done. |
| V14 | CONTRADICTED for ggml-node | No draft/speculative support in ggml-node. node-llama-cpp has `DraftSequenceTokenPredictor`. Skip §15.2 item 9. |

**Consequence for config (§2 rule 1, §18.1):** `packages/config` and its 30 parity fixtures were
written against the spec's description of Frontal Code (single `project.json` lookup, `RUSTY_CLAUDE_PERMISSION_MODE`,
`.frontal-code`/`.git` root discovery, `project.json` `permission_mode` precedence). The Rust source does
not behave that way, so the parity suite proves agreement with the spec, not with Frontal Code. The
trust and permission rules need a human decision before M1 (see the open questions in the session summary).

## 2026-11-01 — M0 implementation status

- `packages/config`: `keys.ts` rewritten. The t3 `createEnv` call was wrong for the installed API and read env at import
  time. It is now a per-call zod parse (`zod` declared as a dependency of `@fcx/config`). Permission mode is validated
  by the resolver, not silently dropped. Added `ResolveOptions.permissionMode` (CLI flag, highest precedence).
- `packages/config/src/parity.test.ts`: `process.env.X = undefined` stored the string `"undefined"`. Keys are now removed.
  Zod is imported as a namespace (`import * as z`) because Bun's runtime resolves the named export `z` to `undefined`
  under `bun run test`.
- `cli`: real argument parser (`src/args.ts`) that rejects unknown flags and invalid values. `status` and `doctor`
  are implemented, with text and JSON output. All other commands return `NOT_IMPLEMENTED` with exit 1, instead of
  printing stub data as if they had run. Bundled with tsup (plan §15.2 item 1); `bin/fcx.js` runs `dist/index.js`.
  `doctor` checks the ggml-node install with `import.meta.resolve`, without loading it.
- Binary name: the repo uses `fcx` (decision 0, option (a)-style). Not changed here; the user has not confirmed it.
- Not done in M0: worker isolation and warm process (`packages/model` host exists, not wired into the CLI), the baseline
  model run, and the ≥20 TypeScript eval tasks (one example task exists). Language-server checks are reported as
  not checked by `doctor`.

## 2026-11-01 — Decisions from the owner

- **Binary name is `fcx`** (confirmed). Decision 0 closed. Package names stay `@fcx/*`.
- **Config follows the real Frontal Code behavior** (the Rust source at `frontal-labs/code` @ `7d44a2fe`), not the spec's
  description. The parity fixtures are to be regenerated from that source, not hand-written from the spec.
- **Continue with the separate TypeScript package** (spec §18.2 option "as specified"). Frontal Code's crates stay the
  source of truth for shared config; ggml-node runs in-process inside `fcx`.

## 2026-11-01 — Config alignment with Frontal Code (Rust source, @ 7d44a2fe)

Applied (verified in source):
- Trust file is `config_home/trusted-workspaces.json` with key `trustedWorkspaces` (`code-runtime/src/config.rs:889-930`).
  fcx read `trusted`, so a workspace trusted by `frontal-code` looked untrusted. Fixed; fixtures updated.
- Withheld keys in untrusted workspaces match Rust: `hooks, mcpServers, plugins, enabledPlugins, sandbox, permissionMode`
  plus `permissions.defaultMode`. `permissions.allow` ignored in project/local settings. Already matched.

Not applied. Frontal Code's behavior here is unresolved or conflicting, and each change moves the security model,
so these are open questions for the owner:
1. **Mode labels.** Rust accepts `default|plan|read-only`, `acceptEdits|auto|workspace-write`, `dontAsk|danger-full-access`
   (`parse_permission_mode_label`). It does not accept `prompt`, which is fcx's default. An unknown label is a hard error in Rust, and fcx warns and ignores it.
2. **project.json `runtime.permission_mode`.** Rust parses it but the runtime never reads it (`ConfigurationManager` ignores project.json).
   Its own test expects `prompt`, and the Rust label set does not include it.
3. **`RUSTY_CLAUDE_PERMISSION_MODE`.** Not referenced anywhere in `crates/`. fcx still reads it.
4. **Default when no mode is set.** Rust returns `None`; the consumer behavior is not confirmed. fcx defaults to `prompt`.
5. **Project root.** Rust uses `cwd` for project/local settings and trust prefix matching (canonicalized). fcx walks up to `.frontal-code/` or `.git/`.
   The two differ when `cwd` is a subdirectory.
6. **project.json lookup.** Rust takes the first existing file among the three home locations, then a `Cargo.toml` walk-up for `config/project.json`. fcx also checks `config/project.json` under the workspace root.

## 2026-11-01 — Decisions taken from the plan (owner: "decide based on the plan")

Config (§5.1–§5.3, aligned to `frontal-labs/code` source):
1. **Mode labels.** Settings accept Frontal Code aliases: `default|plan|read-only` → read-only,
   `acceptEdits|auto|workspace-write` → workspace-write, `dontAsk|danger-full-access` → danger-full-access.
   `prompt` is fcx's own mode and is accepted too. An unknown label is reported and ignored, which never widens access.
2. **project.json `runtime.permission_mode`** is not applied. Frontal Code's runtime never reads it. fcx warns.
3. **`RUSTY_CLAUDE_PERMISSION_MODE`** is removed. Frontal Code does not read it. Use `--permission-mode`.
4. **Default** is `prompt` when no source sets a mode.
5. **Workspace** is the canonical `cwd`. There is no parent-directory walk. Trust matching canonicalizes the
   path. Reported paths are the paths as given.
6. **project.json** lookup: first existing of `FRONTAL_CODE_CONFIG_HOME`, `FRONTAL_CODE_HOME`,
   `$HOME/.frontal-code`, then a walk up from the cwd for a directory with `Cargo.toml` and `config/project.json`.
   An unreadable file warns and falls back to defaults.
7. **Effective mode** is the lowest of user, project and local settings. A project or local mode above the user's
   is capped, with a warning. A CLI flag overrides for this run. A policy `permissionCeiling` caps it.
8. **Malformed JSON** in any settings file, or a malformed trust file, is a `ConfigError`. Silently ignoring it
   would be the unsafe default.
9. **Withholding:** one warning per withheld key, as §5.1 requires, with the Rust wording.
10. **Trust file** key is `trustedWorkspaces`. A file without that key means no trusted workspaces.

Fixtures: `fixtures/config/cases/{003,004,005,009,011,012,021,023,030}/expected.json` were regenerated for the
decisions above. Each changed key was reviewed by hand. **These are regression fixtures, not independent oracles.**
I could not run the Rust suite: a `cargo test` in the external `frontal-labs/code` checkout was blocked by the
permission classifier, because it would run that repo's build scripts.

Product slice (M1 subset, deliberate deviations recorded here):
11. **Diagnostics and verify** use the TypeScript language service in-process, with in-memory overlays. The LSP
    server pool (§8.4) is not built.
12. **Context** comes from the TypeScript checker, one hop of definitions, with a character budget. The SQLite index,
    FTS5, vectors and co-change edges (§8.1–§8.3) are not built. The `index` and `retrieve` packages are not a
    full index.
13. **Ground layer (§10.2)** is covered by verify for TypeScript: an unknown identifier is a TS2304 error and is
    rejected as a new error. A separate tree-sitter ground layer is deferred to the non-TS languages.
14. **Candidate 0 is the compiler's quick fix** (`getCodeFixesAtPosition`), when it has one. It needs no model and
    goes through the same three layers. Model candidates follow, at temperatures from §10. This follows the
    plan's rule that the harness does the deterministic work and the model fills the constrained slot.
15. **Feedback loop:** a rejected candidate's reason is added to the next prompt. The fix-diagnostic prompt is the
    versioned `prompts/fix-diagnostic.md`, and a test keeps the embedded copy identical.
16. **Approval:** `prompt` mode asks on a TTY and declines without one. A declined change shows the proposal and
    exits 3.
17. **Undo** keeps the originals under `cache/undo/<repo-key>/` and refuses if a file changed since fcx wrote it.
18. **Model load failures** are errors with a hint, not candidate failures. A load failure must not look like an abstention.
19. **Not built in this slice:** worker-process isolation (§6.1), the warm socket process (§15.2 item 3), escalation
    (§12.3), memory (§12.1), ACP (§11.2), the eval harness (§14), `fix-test`, `write-test` and the other recipes, and
    fine-tuning (§13). Each is still open in the plan.

Real-model observation (not a benchmark): with the cached `qwen2.5-1.5b-instruct-q4_k_m.gguf`, the model
produced candidates that every layer rejected, on two sample TypeScript errors, one of them trivial (a string
where a number is expected). The pipeline works. The model's fix quality is the bottleneck, which the plan
expects. An eval set (§14) is needed before tuning or fine-tuning.

## 2026-11-01 — Review findings and fixes (code review and security review)

Fixed, each with a regression test:
- **Project mode bypass (high):** project or local `permissionMode` could grant `danger-full-access` in a trusted
  workspace with no user mode. Non-user modes are now capped at the user's lowest mode, or at `prompt` when the
  user sets none. Parity fixture 026 changed for this reason.
- **Prototype pollution (high):** a `__proto__` key in settings reached `Object.prototype`. Unsafe keys are dropped
  while parsing and merging, and only own properties are read.
- **Repo-controlled `config/project.json`:** the walk-up fallback is read only in a trusted workspace, since it can
  set the undo and log directories. Non-string path overrides are ignored instead of crashing.
- **Deny and ask lists** are unioned across sources, so a repo cannot drop the user's denies.
- **Stale check was vacuous:** the plan re-read the file after generation and approval. Edits are now planned from
  the exact text they were verified against, and the write is refused if the disk differs.
- **Symlinks and containment:** symbolic links are refused, and a path whose real location is outside the workspace
  is refused. Definitions outside the workspace are never sent to the model.
- **Non-transactional writes:** all temp files are staged before any target changes. A failed rename rolls back the
  files already replaced.
- **Permission bits:** the rewritten file keeps its mode (for example 0755).
- **Undo** refuses a recorded path outside the workspace, as well as a file changed since fcx wrote it.
- **Duplicate identical errors:** verify counts errors per code and message. Fixing one of two identical errors is
  now accepted. Before, every such fix abstained.

Closed in a follow-up:
- **tsconfig reading outside the workspace.** The checker keeps only input files inside the workspace, and drops
  `paths` targets, `baseUrl` and `typeRoots` that resolve outside it. A test confirms the outside file never
  enters the program. Remaining limit: `extends` is still merged by the compiler, so a parent config outside the
  workspace can still contribute options. Its files are not program inputs, and their contents are not sent to the model.
- **Same-message netting.** The count check rejects the case where a fix adds an identical error elsewhere, because
  the target's count does not go down. Covered by a test. A different error that a candidate introduces is rejected
  as NEW_ERROR.

## 2026-11-01 — Code structure and test coverage pass

- **Barrel-only `index.ts`.** Every `index.ts` in `packages/*/src` and `cli/src` now only re-exports. The code moved to
  focused modules: config (types, errors, permissions, trust, settings, json, policy, project, fc-settings, paths,
  resolve), apply (types, errors, hash, path, io, text, plan, apply, undo), verify (types, paths, confine, checker,
  diagnostics, codefix), defense (types, util, constrain, anchor, verify), retrieve (types, constants, ast, filter,
  gather, render), and the CLI (`app.ts` for commands, `main.ts` for startup). The bundle entry and the binary now
  point at `main.ts`.
- **Placeholder packages.** `acp`, `escalate`, `index`, `lsp` and `memory` are unbuilt scaffolds with no code. Their
  `index.ts` is now `export {};`. They are NOT deleted: the owner has not decided whether to build them or remove them.
- **Typesafety.** Casts in the CLI argument parser and the rollback loop were replaced with a type guard and a
  bounds-checked index. Remaining casts sit at trust boundaries: parsed JSON in config (`ProjectConfig`, `MergedSettings`),
  and the ggml-node branded `ModelId`. Those are shape-checked where the fields are read.
- **Tests.** 142 tests across 19 files, including new suites for the apply text engine and path containment, the
  defense layers, retrieval, the model registry, the fix recipe (prompt-sync, schema limits, invalid output, model load
  failure, compiler-first path, layer events) and the CLI helpers.

## 2026-11-01 — Eval and performance measurements (real local model)

Eval set: `evals/tasks/ts/fix-diagnostic-local/` (12 mutation-generated tasks, tagged `mutation: true`), generated by
`evals/generate-local-tasks.py`. Runner: `bun evals/run.ts`. Model: cached `qwen2.5-1.5b-instruct-q4_k_m`, the default
`ggml/auto`, 4 candidates (tier S budget). Report: `evals/reports/local-full.json`.

| Category | Passed | Source of the passing fix |
|---|---|---|
| missing-import (3) | 3/3 | compiler quick fix, about 300 ms |
| misspelled-name (3) | 3/3 | compiler quick fix, about 270 ms |
| return-type (3) | 3/3 | model, first candidate, 0.8–1.1 s |
| annotation-mismatch (3) | 1/3 | model, first candidate; 2 abstained after 6 candidates |

Total 10/12. Median task time 836 ms. The two failures are real: the model did not produce a fix that passed every
layer, and the result is abstention, not a wrong write. This is a small set, mutation-generated, so it shows
the pipeline works and where the model is weak. It is not a benchmark of real-world quality. The existing
`evals/tasks/ts/*` files reference placeholder repositories and cannot be run.

Stage timings (non-model), `bun benchmarks/fix-stages.ts --files 200 --runs 5`, median of 5, on arm64 under Bun
(Node v24.3.0 reported by Bun): checker startup and first diagnostics 214 ms; compiler quick fix 9 ms; context
gathering 1.7 ms; warm verify call 16 ms. The per-task cost is dominated by the model, not by the checker.

## 2026-11-01 — Package status and open risks (packages built in parallel)

- **Verified by running:** `@fcx/escalate` (51 tests), `@fcx/acp` (23), `@fcx/memory` (54), `@fcx/lsp` (26), each with lint and typecheck clean.
- **ACP stop reasons.** ACP v1 has no `error` stop reason. A failed task is now a JSON-RPC internal error, and an unknown handler stop reason is rejected. The earlier cast is gone.
- **Workspace binaries are untrusted by default** (`@fcx/lsp`). A repository's `node_modules/.bin` and `tsserver.js` are used only with `trustWorkspace: true`, and then only if they resolve inside the workspace after symlinks. The CLI must pass this flag from the config trust result. That is not wired yet.
- **OPEN RISK, must resolve before the LSP pool is used for accept/reject:** `@fcx/lsp` treats a silent server as "clean" after `silentCleanMs` (500 ms). A slow server could then report no errors for a broken edit. The in-process TypeScript checker in `@fcx/verify` is still the verifier the CLI uses, so no fix is affected yet.
- **OPEN DECISION:** `node:sqlite` (used by `@fcx/index` and `@fcx/memory`) is not implemented by Bun 1.3, which `package.json` lists as a supported engine. The CLI runs on Node 22. Either drop the Bun engine claim or switch the SQLite binding.
- **Not done in these packages:** real rust-analyzer, gopls and pyright tests; no `$/cancelRequest`; the ACP warm socket (§11.3); no real editor test; memory is not wired into the CLI or recipes; escalate is not wired into the CLI.

## 2026-11-01 — Test runtime: Node, not Bun

- `packages/index` and `packages/memory` use `node:sqlite`, which Bun 1.3 does not implement. `packages/escalate`'s
  real-HTTP tests also fail under Bun. Running the suite under Bun gives 103 failures, all of them runtime
  incompatibilities. Bun's `run` shims `node` for every child process, so no script can route around it.
- Under Node 22 the full suite passes: 36 files, 346 tests (`bunx vitest run` or `npx vitest run`).
  `bun run test` is therefore NOT a supported entry point.
- OPEN DECISION (owner): either drop Bun from `engines` and the docs, or replace `node:sqlite` with a dual
  driver (`bun:sqlite` under Bun). The product currently requires Node 22.

## 2026-11-01 — Owner decisions taken (delegated: "you do the decisions")

1. **Runtime is Node 22 only.** Every package and the CLI declare `engines.node >=22.0.0`. Bun stays as the package
   manager and script runner (plan §4.2), but not as a supported runtime, because Bun 1.3 lacks `node:sqlite` and
   ran the HTTP tests differently. The test suite runs under Node (`bunx vitest run`).
2. **LSP never reports silence as clean.** The silent-clean heuristic is removed. An overlay check returns the diagnostics
   the server published for that exact version, or `TIMEOUT` when it publishes nothing. typescript-language-server 6.0.2
   does not advertise pull diagnostics (`diagnosticProvider`), even with the client capability declared, so the pool cannot
   confirm a clean state with it. Limitation: a check whose previous state was already clean can therefore report `TIMEOUT`
   (unknown). The overlay revert no longer waits for a publish, which would otherwise cost a full timeout each time.
   The accept/reject decision stays with the in-process TypeScript checker in `@fcx/verify`.
3. **Placeholder packages are built.** `acp`, `escalate`, `index`, `lsp` and `memory` have implementations and tests
   (see the status entry above). Nothing is deleted.

## 2026-11-01 — Second wave decisions (coordinator)

- **Cite identifier rule.** `@fcx/defense` cite checks only code-like tokens against a citation: backticked words,
  call names, dotted bases and members, and words with `_`, `$` or camelCase. Prose words are not checked. Without this,
  nearly every explanation claim would be dropped.
- **Exit code 4** means escalation declined by the user after an abstain. Exit 2 is abstained, exit 3 declined.
- **Index excludes its own database.** The indexer used to index the SQLite file and its `-wal` and `-shm` sidecars when
  the database sat in the workspace. Fixed, with the real path of the database directory compared (macOS `/var` vs
  `/private/var`). A latent bug: the CLI's default cache is outside the workspace.
- **Index count methods** `fileCount`, `symbolCount`, `edgeCount`, `chunkCount` are public for `fcx index --status`.
- **Python verification runs isolated** (`python -I`) with the candidate in its own subdirectory and an empty working
  directory. A repo file named like a stdlib module must never be imported during verification. Found by a security review.
- **Go and Rust verifiers** copy only the files they need into a temp directory. Go does not resolve imports of other
  packages in the module, so multi-package candidates can be rejected wrongly. Rust checks only `src/`.
- **Dependencies.** `typescript` moved to runtime dependencies in `@fcx/defense` (its code imports it at runtime).
  The CLI declares `@fcx/memory`, `@fcx/escalate`, `@fcx/index` and `@fcx/lsp`.

## 2026-11-01 — Third wave decisions (coordinator)

- **Policy before the escalation offer.** A provider the policy forbids is never offered to the user.
- **Global flags work before and after the command.** `--no-escalate`, `--output-format`, `--permission-mode`, `-C`,
  `--dry-run`, `-h`, `-v` are recognized in both positions. Command arguments pass through untouched.
- **Recipe engine** (`@fcx/recipes`): one candidate loop for every recipe. fix-diagnostic runs on it unchanged.
  New recipes: fix-test, write-test, implement, refactor-small. Test runners are not in `@fcx/verify`, so fix-test
  reports test-run as not run.
- **Open items after this wave:** add-types, docstring, rename-extract, explain, commit-message and the router are
  not built. The CLI does not yet expose the four new recipes. Recipe prompts are inline, not `prompts/<id>.md`.
  The instructions block from `projectInstructions` is reported but not passed into any recipe prompt. The
  escalation defense pipeline is a copy of the recipes pipeline and can drift. `fcx fix` does not use the LSP pool.
  The warm background process (plan §15.2 item 3) is not built, and its default stays off. Fine-tuning (plan M3):
  this sentence was WRONG. The M1 Max can run MLX LoRA on a 1.5B model. See the 2026-11-02 fine-tuning entry.
- **Test timeouts.** The fix-level memory tests run the real TypeScript checker, which is slow under full-suite
  CPU contention, so they have a 30 s budget. Verified stable over two full runs (59 files, 526 tests).

## 2026-11-01 — Warm process (`fcx serve`) decisions

- **Default off.** Enabled only by `fc.warmServer: true` or `FCX_WARM=1` (plan §18.7 is answered: no daemon by default).
- **No retry after a request is sent.** A dropped connection after the request was written is reported as an error
  (exit 1). The client never re-runs the command in-process, because a mutating command could apply twice.
  Before the request is written, the client falls back to in-process as before.
- **Warm requests never approve or escalate.** Interactive `fix` runs in-process when stdin is a terminal, and
  prompts decline inside the server.
- **Known limits.** The client's environment is not forwarded, so the cache directory must match between the
  client and the server (a mismatch falls back in-process). The 200 ms check is a connect, not a ping.
- **Cleanup owed by the owner.** A temporary cache directory from the warm-server smoke test was not removed by the
  agent (`/var/folders/.../T/fcxs.*`), and the build log is at `/tmp/fcx-build.log`. Both are safe to delete.

## 2026-11-01 — Recipe wave decisions (coordinator)

- **All recipes exported.** add-types, docstring, rename-extract (rename only; extract not implemented), commit-message,
  explain and the router are in the `@fcx/recipes` barrel. verifyEdits is shared by the CLI's escalation path and the engine.
- **Project instructions** are placed at the start of the user part of every recipe prompt, under `Project instructions:`.
  The system text is byte-identical, so the prompt-prefix cache still works. Text over 1200 characters is cut to whole
  lines (about 300 tokens), and `instructionsTruncated` is reported.
- **prompts/explain.md was replaced** with the inline system text that the code sends, because the cite layer needs
  backticked identifiers. The previous file is in git history at commit cd3aeb9.
- **Verified by running:** `@fcx/recipes` 124 tests, `@fcx/cli` 97 tests, lint and typecheck clean.
- **Known limit:** the fix-test recipe has no test runner in the packages, so it verifies the type check only and
  reports test-run as not run.

## 2026-11-01 — CLI wiring of recipes (verified)

- All recipe commands exist: test, fix-test, implement, types, doc, refactor, rename, explain, commit, ask.
  Verified by running: 75 files and 676 tests across the repository, lint and typecheck clean.
- Limits: all recipe tests use scripted models, so output quality with the real model is not verified.
  `fcx test` only proposes, because @fcx/apply cannot create new files. fix-test runs no tests; it takes --output.
  `commit --apply` requires a terminal and an explicit yes, and declines without a TTY (after generating the message).
  Accepted results from the new commands are not written to memory, and escalation is offered only by fix.

## 2026-11-01 — Final verified state of this round

- **Verified by running:** lint and typecheck clean across the repository; full test suite 76 files and 688 tests passing;
  `bun run build` succeeds; the built `fcx acp` answers `initialize` over stdio with protocol version 1.
- **ACP** (`fcx acp`): routes prompts through the same router and command dispatch. Each run uses the workspace's
  configured permission mode; the client cannot elevate it. Prompts decline in protocol mode. Writes go through the
  CLI apply path, and cancelled runs cannot write.
- **Not done, and why:**
  - Fine-tuning (plan M3): this line was WRONG. The machine can run it (MLX LoRA). Corrected in the 2026-11-02 entry.
  - Real-editor test of ACP: no editor is installed here.
  - Output quality of the recipes with the real model: every recipe test uses a scripted model. The only real-model
    measurement is the fix-diagnostic eval (10 of 12 on mutation-generated tasks).
  - ACP warm reuse, candidate-n-of-N progress, and client-side edit proposals.
  - LSP pool in the fix path, and Go/Python/Rust symbol extraction in the index.

## 2026-11-02 — Fine-tuning and recipe evaluation: status

**Fine-tuning (plan M3): partial.** No result is recorded yet, because the held-out run has not finished.
- Done: base model Qwen2.5-1.5B-Instruct (Apache-2.0, checked on the model card). MLX environment with mlx-lm 0.32.2.
  Task generator in `training/gen_tasks.py`: 30 template families, split by family (train 300, validation 60, test 150).
  Collection pipeline in `training/src/`. LoRA config in `training/configs/fix-diagnostic.yaml`.
  Smoke tests: base model 2 of 4 verified on train tasks; the compiler quick fix covers all missing-import tasks.
- Still running at this entry: data collection (`training/data/fix-diagnostic/`).
- Not done: LoRA training, fuse, base and fine-tuned held-out evaluation, report.
- **Blocked on your decision:** the GGUF export needs llama.cpp (`convert_hf_to_gguf.py` and `llama-quantize`). Cloning
  that repository was denied by the auto-mode classifier as external code, and it would run build scripts. I did not work
  around that. Without a GGUF the fine-tuned model cannot run in the product runtime, so the ship step is blocked. Options:
  allow the clone and build, or provide a built checkout via `LLAMA_CPP_DIR`.
- Limits when it does run: about 300 training tasks, self-distilled from the same 1.5B model, so gains may be small. The
  150-task test split gives wide intervals. One machine.

**Recipe eval (all recipes, real local model): in progress.** An earlier run under Bun was invalid: retrieval needs
`node:sqlite`, which Bun lacks, so later tasks failed for that reason and those results are discarded. The current run uses
Node 22 (`evals/ts-register.mjs`). Its report will be `evals/reports/recipes-2026-11-01.json`. The tasks are small and
synthetic, so the pass rates say little about real code.

**Lint:** `training/src/collect.ts` now passes lint, and Biome ignores the training virtual environment and reports.

## 2026-11-02 — Grammar bug found by the recipe eval, fixed

- **Bug:** the commit-message schema used a regex on `scope`. ggml-node's grammar builder rejects the JSON Schema
  `pattern` keyword, so every commit-message candidate failed before the model ran. The first eval reported 0 of 8, and
  that number was caused by this bug, not by the model.
- **Fix:** the schema has no regex. The scope format is checked in the verify layer, with feedback the model can act on.
  Probed with the real grammar builder: all eleven recipe schemas are accepted (the explain probe failed only because
  the probe's token limit cut the output short).
- **Result after the fix (real local model, 8 generated tasks):** commit-message 7 of 8 verified.
- **Recipe eval, first complete run (real local model, synthetic tasks, small):** add-types 1/10, docstring 0/9,
  implement 8/9, refactor-small 3/8, rename-extract 9/9, write-test 3/8, fix-test 0/8, explain 1/8. The failures
  for add-types, docstring, refactor-small and write-test are model output that the checks reject. These are not
  measured causes beyond that. Report: `evals/reports/recipes-2026-11-02.json`.

## 2026-11-02 — Fine-tuning training run (completed)

- **Config:** `training/configs/fix-diagnostic.yaml`: Qwen2.5-1.5B-Instruct, LoRA rank 8 on attention and MLP projections
  of all 28 layers, batch 2, 300 iterations, learning rate 1e-4, max sequence 2048, seed 0. Trainable 0.598% (9.2M).
- **Data:** 192 training examples, 38 validation examples, self-distilled from the local model with verification.
- **Validation loss:** 1.445 at start, 2.143 at iteration 100, 1.186 at 200, 0.992 at 300. The curve is noisy. The end
  point is lower than the start, but the held-out test result is what counts.
- **Not yet:** the held-out test comparison (see the measurement entry when it is written) and the GGUF needed to run the
  fine-tuned model in the product runtime. The GGUF is blocked on the llama.cpp decision.

## 2026-11-02 — Fine-tuning result: NOT shipped

- **Held-out test split** (90 model-resolved tasks; 60 compiler-resolved excluded from the comparison; MLX inference,
  not the product runtime). Fence-stripped parse, the fair one, because the base model wraps every output in a
  ```json fence:
  - Base: 34/90 (37.8%, Wilson 95% [28.5%, 48.1%]).
  - Fine-tuned LoRA: 15/90 (16.7%, [10.4%, 25.7%]).
  - Paired: base passed 19 tasks the fine-tuned model failed; the fine-tuned model passed none of base's failures.
    Exact sign test p = 4e-6. The 21-point gap is larger than both intervals.
  - Strict parsing shows fine-tuned 15/90 and base 0/90, but that is an artifact of base's fence, so it is not cited.
- **Decision:** the fine-tuned model is not shipped. The GGUF export is therefore not needed now. The llama.cpp approval
  question is moot for shipping, and remains open only if the owner wants to pursue another training run.
- **Likely causes (not tested):** 192 training examples is too few; validation loss rose to 2.14 at iteration 100; the
  fine-tuned model fails the argument-type and return-type tasks completely (0/30 each), and several outputs are
  anchor mismatches. A next attempt would need more and more varied data, early stopping on validation, and evaluation
  under the product grammar.
- **Report:** `training/reports/mlx-test-2026-11-02.json`. Prompts and completions are in `training/eval-mlx/`.
