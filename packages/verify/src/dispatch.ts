import { extname } from "node:path";
import { verifyGo } from "./go.js";
import { languageForPath } from "./language.js";
import { verifyPython } from "./python.js";
import { verifyRust } from "./rust.js";
import type { VerifyOptions, VerifyResult } from "./verify-types.js";

/**
 * Routes a candidate to the verifier for its language. TypeScript is not handled here; use
 * `createTsChecker`. Unknown languages are reported as unavailable, never as clean.
 */
export function verifyCandidate(options: VerifyOptions): Promise<VerifyResult> {
  const language = languageForPath(options.file);
  switch (language) {
    case "go":
      return verifyGo(options);
    case "python":
      return verifyPython(options);
    case "rust":
      return verifyRust(options);
    case "typescript":
      return Promise.resolve({
        language,
        available: false,
        errors: [],
        reason: "TypeScript is verified in-process by createTsChecker, not by verifyCandidate",
      });
    case "unknown":
      return Promise.resolve({
        language,
        available: false,
        errors: [],
        reason: `no verifier for ${extname(options.file) || "this file"}`,
      });
  }
}
