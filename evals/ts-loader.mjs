// Resolves `./x.js` imports to `./x.ts` when the TypeScript source exists. Lets Node run the packages' sources.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const ts = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\.js$/, ".ts");
    if (existsSync(ts)) return next(pathToFileURL(ts).href, context);
  }
  return next(specifier, context);
}
