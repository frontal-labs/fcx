import { stdin, stdout } from "node:process";
import { type Interface, createInterface } from "node:readline";
import { FcError } from "@fcx/config";
import type { GlobalArgs } from "../args.js";
import { parseGlobalArgs } from "../args.js";
import { meta } from "../meta.js";

/** The commands a person can type at the prompt. Anything else is a fcx command line, without the leading `fcx`. */
export const TUI_HELP = `Type a fcx command as you would on the shell, without the leading "fcx":

  explain packages/model/src/registry.ts:1-40 "what does this do?"
  status
  doctor
  trust

Built-ins:
  /help     Show this help
  /exit     Leave (also Ctrl+D or Ctrl+C)

Flags work too, for example: --permission-mode read-only explain ...`;

const HISTORY_SIZE = 200;

/** The terminal streams the UI reads and writes. Tests pass pipes; the CLI passes the process streams. */
export interface TuiStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

/**
 * Splits a line into words the way a shell would for simple cases: spaces separate words, single or double
 * quotes group them, and a backslash escapes the next character. An unclosed quote is an error.
 */
export function tokenize(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} quote`);
  if (inWord) words.push(current);
  return words;
}

/**
 * Prints an error the way the shell does: a FcError with its code and hint, anything else as its message.
 * Keep in step with `main` in main.ts.
 */
function reportError(out: NodeJS.WritableStream, err: unknown): void {
  if (err instanceof FcError) {
    out.write(`${err.code}: ${err.message}\n`);
    if (err.hint) out.write(`${err.hint}\n`);
  } else {
    out.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** Opens the line editor. The history array is shared with readline, which records each line on Enter. */
function openEditor(streams: TuiStreams, history: string[]): Interface {
  const rl = createInterface({
    input: streams.input,
    output: streams.output,
    terminal: (streams.output as { isTTY?: boolean }).isTTY === true,
    prompt: "fcx> ",
    historySize: HISTORY_SIZE,
    history,
  });
  // Ctrl+C at the prompt leaves the UI. Without a listener, readline would only pause.
  rl.on("SIGINT", () => rl.close());
  return rl;
}

/** Resolves with the next line, or null when the editor closes (Ctrl+D, Ctrl+C, end of input or /exit). */
function readLine(rl: Interface): Promise<string | null> {
  return new Promise((resolve) => {
    const onClose = (): void => resolve(null);
    rl.once("close", onClose);
    rl.question(rl.getPrompt(), (answer) => {
      rl.off("close", onClose);
      resolve(answer);
    });
  });
}

/**
 * The interactive terminal UI. It reads a fcx command line, runs it through `dispatch` (the same path as the
 * shell command), and prints the result. Command output is printed as usual; the editor is closed while a command
 * runs, so approval prompts can read from the terminal, and reopened afterwards with the same history.
 */
export async function runTui(
  dispatch: (args: GlobalArgs) => Promise<number>,
  cwd: string,
  streams: TuiStreams = { input: stdin, output: stdout },
): Promise<number> {
  const out = streams.output;
  out.write(`fcx ${meta.version} · ${cwd}\nType /help for commands, /exit to leave.\n\n`);

  const history: string[] = [];
  let rl = openEditor(streams, history);
  let exitCode = 0;

  for (;;) {
    const line = await readLine(rl);
    if (line === null) break;
    const text = line.trim();
    if (text === "") continue;

    if (text === "/exit" || text === "/quit" || text === "exit" || text === "quit") break;
    if (text === "/help" || text === "help") {
      out.write(`${TUI_HELP}\n`);
      continue;
    }

    let words: string[];
    try {
      words = tokenize(text);
    } catch (err) {
      reportError(out, err);
      continue;
    }
    if (words[0] === "tui") {
      out.write("Already in the terminal UI.\n");
      continue;
    }

    rl.close();
    try {
      exitCode = await dispatch(parseGlobalArgs(words));
    } catch (err) {
      reportError(out, err);
      exitCode = 1;
    }
    out.write(`(exit ${exitCode})\n\n`);
    rl = openEditor(streams, history);
  }

  rl.close();
  out.write("\n");
  return 0;
}
