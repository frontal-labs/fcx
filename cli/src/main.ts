import { FcError } from "@fcx/config";
import { run } from "./app.js";
import { type GlobalArgs, parseGlobalArgs } from "./args.js";

export async function main(): Promise<void> {
  let args: GlobalArgs;
  try {
    args = parseGlobalArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await run(args);
  } catch (err) {
    if (err instanceof FcError) {
      console.error(`${err.code}: ${err.message}`);
      if (err.hint) console.error(err.hint);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  }
}

void main();
