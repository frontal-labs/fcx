"""Generates self-contained recipe eval tasks, one directory per recipe under evals/tasks/ts/<recipe>-local/.

Every task inlines a tiny TypeScript project (files plus tsconfig.json), the recipe's input, and a machine-checkable
criterion in "check". The runner (evals/run-recipes.ts) reads these fields; it does not infer criteria itself.

All tasks are synthetic and written by hand here: small shapes, varied names. They are NOT drawn from real repos,
so the pass rates say little about performance on real code.

Run: python3 evals/generate-recipe-tasks.py
"""
import json, os, re, shutil

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks", "ts")

TSCONFIG = json.dumps(
    {
        "compilerOptions": {
            "strict": True,
            "target": "ES2022",
            "module": "ESNext",
            "moduleResolution": "bundler",
            "noEmit": True,
        },
        "include": ["src", "tests"],
    },
    indent=2,
) + "\n"

# Test globals for recipes that write or fix tests. No test runner exists in the task, so `test` and `expect`
# are declared here and the criterion is type-checking only.
TEST_GLOBALS = (
    "declare function test(name: string, fn: () => void): void;\n"
    "declare function expect(actual: unknown): {\n"
    "  toBe(expected: unknown): void;\n"
    "  toEqual(expected: unknown): void;\n"
    "};\n"
)


def line_of(content, marker):
    """1-based line of the first line that contains `marker`."""
    for i, line in enumerate(content.split("\n")):
        if marker in line:
            return i + 1
    raise ValueError(f"marker not found: {marker!r}")


def col_of(content, marker, ident):
    """1-based column of the whole word `ident` on the first line that contains `marker`."""
    for line in content.split("\n"):
        if marker in line:
            m = re.search(r"\b" + re.escape(ident) + r"\b", line)
            if m is None:
                raise ValueError(f"ident {ident!r} not on marker line")
            return m.start() + 1
    raise ValueError(f"marker not found: {marker!r}")


def block_range(content, start_marker):
    """1-based (start, end) lines: the line with start_marker, through the first closing brace at its indent."""
    lines = content.split("\n")
    start = line_of(content, start_marker)
    indent = len(lines[start - 1]) - len(lines[start - 1].lstrip())
    closing = " " * indent + "}"
    end = next(j + 1 for j in range(start, len(lines)) if lines[j] == closing)
    return start, end


def base(files, extra_files=None):
    out = {"tsconfig.json": TSCONFIG}
    out.update(files)
    if extra_files:
        out.update(extra_files)
    return out


def write_task(recipe, task):
    d = os.path.join(ROOT, f"{recipe}-local")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{task['id']}.json"), "w") as fh:
        json.dump(task, fh, indent=2)
        fh.write("\n")


def make(recipe, idx, shape, files, inp, check, before=None):
    task = {
        "id": f"{recipe}-{idx:02d}",
        "recipe": recipe,
        "shape": shape,
        "synthetic": True,
        "files": files,
        "input": inp,
        "check": check,
    }
    if before is not None:
        task["before"] = before
    return task


tasks = {}

# ---------------------------------------------------------------------------------------------------------------
# add-types: a symbol whose declaration has no explicit type. The rest of the file type-checks before the edit.
# ---------------------------------------------------------------------------------------------------------------
ADD_TYPES = [
    ("function-return", "greet",
     'export function greet(name: string) {\n  return `hello ${name}`;\n}\n'),
    ("const-number", "retries",
     "export const retries = 3;\n"),
    ("function-boolean", "parseFlag",
     'export function parseFlag(raw: string) {\n  return raw === "1" || raw === "true";\n}\n'),
    ("const-object", "defaults",
     'export const defaults = { port: 8080, host: "localhost", secure: false };\n'),
    ("class-property", "count",
     "export class Counter {\n  count = 0;\n\n  increment(by: number) {\n    this.count += by;\n    return this.count;\n  }\n}\n"),
    ("function-reduce", "total",
     "export function total(values: number[]) {\n  return values.reduce((sum, v) => sum + v, 0);\n}\n"),
    ("const-array", "TAGS",
     'export const TAGS = ["alpha", "beta"];\n'),
    ("function-object", "pair",
     "export function pair(a: string, b: number) {\n  return { first: a, second: b };\n}\n"),
    ("function-predicate", "isEmpty",
     "export function isEmpty(list: string[]) {\n  return list.length === 0;\n}\n"),
    ("function-template", "makeId",
     "export function makeId(prefix: string) {\n  return `${prefix}-${Math.floor(Math.random() * 1000)}`;\n}\n"),
]
for i, (shape, symbol, content) in enumerate(ADD_TYPES, 1):
    path = f"src/add_types_{i:02d}.ts"
    tasks.setdefault("add-types", []).append(make(
        "add-types", i, shape, base({path: content}),
        {"file": path, "symbol": symbol},
        {"symbol": symbol, "typeCheckFile": path},
    ))

# ---------------------------------------------------------------------------------------------------------------
# docstring: a declaration with no JSDoc block. The criterion looks for a non-empty JSDoc above the declaration.
# ---------------------------------------------------------------------------------------------------------------
DOCSTRING = [
    ("function-clamp", "clamp", "export function clamp",
     "export function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n"),
    ("interface", "Address", "export interface Address",
     "export interface Address {\n  street: string;\n  city: string;\n}\n"),
    ("class", "RateLimiter", "export class RateLimiter",
     "export class RateLimiter {\n  private hits = 0;\n\n  constructor(private readonly limit: number) {}\n\n  take(): boolean {\n    this.hits += 1;\n    return this.hits <= this.limit;\n  }\n}\n"),
    ("arrow-const", "slugify", "export const slugify",
     'export const slugify = (text: string): string =>\n  text.trim().toLowerCase().replace(/\\s+/g, "-");\n'),
    ("function-date", "parseIsoDate", "export function parseIsoDate",
     "export function parseIsoDate(input: string): Date | undefined {\n  const date = new Date(input);\n  return Number.isNaN(date.getTime()) ? undefined : date;\n}\n"),
    ("type-alias", "Result", "export type Result",
     "export type Result<T> = { ok: true; value: T } | { ok: false; error: string };\n"),
    ("generic-chunk", "chunk", "export function chunk",
     "export function chunk<T>(items: T[], size: number): T[][] {\n  const out: T[][] = [];\n  for (let i = 0; i < items.length; i += size) {\n    out.push(items.slice(i, i + size));\n  }\n  return out;\n}\n"),
    ("function-median", "median", "export function median",
     "export function median(values: number[]): number {\n  const sorted = [...values].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n}\n"),
    ("function-format", "formatBytes", "export function formatBytes",
     "export function formatBytes(bytes: number): string {\n  const units = [\"B\", \"KB\", \"MB\", \"GB\"];\n  let index = 0;\n  let value = bytes;\n  while (value >= 1024 && index < units.length - 1) {\n    value /= 1024;\n    index++;\n  }\n  return `${value.toFixed(1)} ${units[index]}`;\n}\n"),
]
for i, (shape, name, marker, content) in enumerate(DOCSTRING, 1):
    path = f"src/docstring_{i:02d}.ts"
    tasks.setdefault("docstring", []).append(make(
        "docstring", i, shape, base({path: content}),
        {"file": path, "line": line_of(content, marker)},
        {"name": name, "typeCheckFile": path},
    ))

# ---------------------------------------------------------------------------------------------------------------
# implement: a function whose body throws the stub error. The criterion: the stub text is gone and the file type-checks.
# ---------------------------------------------------------------------------------------------------------------
STUB = 'throw new Error("not implemented");'
IMPLEMENT = [
    ("parse-duration", "export function parseDuration",
     "/** Parses durations such as 90s, 5m or 2h into seconds. Throws on an unknown unit. */\n"
     "export function parseDuration(text: string): number {\n  " + STUB + "\n}\n"),
    ("slugify", "export function slugify",
     "/** Lowercases a title and joins its words with hyphens. */\n"
     "export function slugify(title: string): string {\n  " + STUB + "\n}\n"),
    ("unique", "export function unique",
     "/** Returns the values without duplicates, keeping the first occurrence of each. */\n"
     "export function unique(values: string[]): string[] {\n  " + STUB + "\n}\n"),
    ("clamp-percent", "export function clampPercent",
     "/** Limits a value to the range 0 to 100. */\n"
     "export function clampPercent(value: number): number {\n  " + STUB + "\n}\n"),
    ("count-words", "export function countWords",
     "/** Counts whitespace-separated words. Blank text has zero words. */\n"
     "export function countWords(text: string): number {\n  " + STUB + "\n}\n"),
    ("invert-map", "export function invertMap",
     "/** Swaps keys and values. When two keys share a value, the later key wins. */\n"
     "export function invertMap(input: Record<string, string>): Record<string, string> {\n  " + STUB + "\n}\n"),
    ("median", "export function median",
     "/** Returns the median of a non-empty list of numbers. */\n"
     "export function median(values: number[]): number {\n  " + STUB + "\n}\n"),
    ("palindrome", "export function isPalindrome",
     "/** True when the text reads the same backwards. Ignores case and non-letter characters. */\n"
     "export function isPalindrome(text: string): boolean {\n  " + STUB + "\n}\n"),
    ("method", "  get(key: string)",
     "export class Cache {\n  private items = new Map<string, string>();\n\n"
     "  /** Returns the value stored under key, or undefined when there is none. */\n"
     "  get(key: string): string | undefined {\n    " + STUB + "\n  }\n\n"
     "  set(key: string, value: string): void {\n    this.items.set(key, value);\n  }\n}\n"),
]
for i, (shape, marker, content) in enumerate(IMPLEMENT, 1):
    path = f"src/implement_{i:02d}.ts"
    tasks.setdefault("implement", []).append(make(
        "implement", i, shape, base({path: content}),
        {"file": path, "line": line_of(content, marker)},
        {"stubMarker": "not implemented", "typeCheckFile": path},
    ))

# ---------------------------------------------------------------------------------------------------------------
# refactor-small: a selection plus an instruction. The criterion: the file type-checks, and the instruction's
# visible effect is present (a string that must appear) or absent (a string that must not appear).
# ---------------------------------------------------------------------------------------------------------------
REFACTOR = [
    ("loop-to-reduce",
     "export interface Item {\n  price: number;\n}\n\n"
     "export function sumPrices(items: Item[]): number {\n  let total = 0;\n  for (const item of items) {\n    total += item.price;\n  }\n  return total;\n}\n",
     "export function sumPrices", "}\n", "Replace the loop with Array.prototype.reduce.",
     {"absent": ["for (const"], "present": [".reduce("]}),
    ("let-to-const",
     "export function badge(name: string): string {\n  let tag = \"user\";\n  return `[${tag}] ${name}`;\n}\n",
     "export function badge", "}\n", "Use const instead of let, because tag is never reassigned.",
     {"absent": ["let tag"], "present": ["const tag"]}),
    ("optional-chaining",
     "export function cityOf(user: { address?: { city: string } }): string | undefined {\n  return user.address && user.address.city;\n}\n",
     "export function cityOf", "}\n", "Use optional chaining instead of the && checks.",
     {"absent": ["user.address && "], "present": ["?."]}),
    ("includes",
     "export function hasAdmin(roles: string[]): boolean {\n  return roles.indexOf(\"admin\") !== -1;\n}\n",
     "export function hasAdmin", "}\n", "Use Array.prototype.includes instead of indexOf.",
     {"absent": ["indexOf"], "present": [".includes("]}),
    ("template-literal",
     "export function greet(first: string, last: string): string {\n  return \"Hello, \" + first + \" \" + last;\n}\n",
     "export function greet", "}\n", "Use a template literal instead of string concatenation.",
     {"absent": ['"Hello, " + first'], "present": ["`Hello, "]}),
    ("remove-unused",
     "export function area(width: number, height: number): number {\n  const unused = 2;\n  return width * height;\n}\n",
     "export function area", "}\n", "Remove the unused variable.",
     {"absent": ["unused"], "present": ["width * height"]}),
    ("ternary-to-if",
     "export function sign(n: number): string {\n  return n < 0 ? \"negative\" : \"non-negative\";\n}\n",
     "export function sign", "}\n", "Rewrite the ternary as an if statement.",
     {"absent": [" ? "], "present": ["if ("]}),
    ("foreach-to-for-of",
     "export function logAll(lines: string[]): void {\n  lines.forEach((line) => {\n    console.log(line);\n  });\n}\n",
     "export function logAll", "}\n", "Replace forEach with a for...of loop.",
     {"absent": [".forEach("], "present": ["for (const"]}),
]
for i, (shape, content, start_marker, end_marker, instruction, effect) in enumerate(REFACTOR, 1):
    path = f"src/refactor_{i:02d}.ts"
    lines = content.split("\n")
    start = line_of(content, start_marker)
    # The selection runs from the start marker to the first line that is exactly the closing brace of that block.
    end = next(j + 1 for j in range(start, len(lines)) if lines[j] == "}")
    tasks.setdefault("refactor-small", []).append(make(
        "refactor-small", i, shape, base({path: content}),
        {"file": path, "startLine": start, "endLine": end, "instruction": instruction},
        {"typeCheckFile": path, "effect": effect},
    ))

# ---------------------------------------------------------------------------------------------------------------
# rename-extract: rename one symbol with a given new name. The criterion: the new name is an identifier in the
# file, the old name is not, and the file type-checks. (Extract is not implemented; this is rename only.)
# ---------------------------------------------------------------------------------------------------------------
RENAME = [
    ("function", "calcTotal", "computeTotal",
     "export function calcTotal(price: number, qty: number): number {\n  return price * qty;\n}\n\nexport const cartTotal = calcTotal(4, 3);\n",
     "export function calcTotal"),
    ("const-number", "MAX_RETRY", "maxAttempts",
     "const MAX_RETRY = 3;\n\nexport function canRetry(n: number): boolean {\n  return n < MAX_RETRY;\n}\n",
     "const MAX_RETRY"),
    ("class", "UserStore", "AccountStore",
     "export class UserStore {\n  private users: string[] = [];\n\n  add(name: string): void {\n    this.users.push(name);\n  }\n}\n\nexport const store = new UserStore();\n",
     "export class UserStore"),
    ("parameter", "factor", "multiplier",
     "export function scale(factor: number, value: number): number {\n  return factor * value;\n}\n",
     "export function scale"),
    ("const-array", "tmp", "doubled",
     "export const tmp = [1, 2, 3].map((n) => n * 2);\n",
     "export const tmp"),
    ("function-call", "fetchUser", "loadUser",
     'export function fetchUser(id: string) {\n  return { id };\n}\n\nexport const u = fetchUser("a");\n',
     "export function fetchUser"),
    ("interface", "PaymentInfo", "PaymentDetails",
     "export interface PaymentInfo {\n  card: string;\n}\n\nexport function charge(p: PaymentInfo): string {\n  return p.card;\n}\n",
     "export interface PaymentInfo"),
    ("let-counter", "counter", "requestCount",
     "let counter = 0;\n\nexport function bump(): number {\n  counter += 1;\n  return counter;\n}\n",
     "let counter"),
    ("parameter-in-template", "name", "person",
     "export function greetAll(names: string[]): string[] {\n  return names.map((name) => `hi ${name}`);\n}\n",
     "(name) =>"),
]
for i, (shape, old, new, content, marker) in enumerate(RENAME, 1):
    path = f"src/rename_{i:02d}.ts"
    tasks.setdefault("rename-extract", []).append(make(
        "rename-extract", i, shape, base({path: content}),
        {"file": path, "line": line_of(content, marker), "column": col_of(content, marker, old),
         "symbol": old, "newName": new},
        {"oldName": old, "newName": new, "typeCheckFile": path},
    ))

# ---------------------------------------------------------------------------------------------------------------
# write-test: a symbol with no test. The criterion: a new file under tests/ or __tests__/, containing the symbol,
# that type-checks.
# ---------------------------------------------------------------------------------------------------------------
WRITE_TEST = [
    ("add", "add", "export function add(a: number, b: number): number {\n  return a + b;\n}\n"),
    ("reverse", "reverseText", 'export function reverseText(text: string): string {\n  return [...text].reverse().join("");\n}\n'),
    ("csv-line", "parseCsvLine", 'export function parseCsvLine(line: string): string[] {\n  return line.split(",").map((part) => part.trim());\n}\n'),
    ("clamp", "clampIndex", "export function clampIndex(index: number, length: number): number {\n  return Math.max(0, Math.min(index, length - 1));\n}\n"),
    ("is-leap", "isLeapYear", "export function isLeapYear(year: number): boolean {\n  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;\n}\n"),
    ("initials", "initials", 'export function initials(fullName: string): string {\n  return fullName\n    .split(" ")\n    .filter((part) => part.length > 0)\n    .map((part) => part[0].toUpperCase())\n    .join("");\n}\n'),
    ("cents", "toCents", "export function toCents(amount: number): number {\n  return Math.round(amount * 100);\n}\n"),
    ("chunk-list", "takeFirst", "export function takeFirst<T>(items: T[], count: number): T[] {\n  return items.slice(0, count);\n}\n"),
]
for i, (shape, symbol, content) in enumerate(WRITE_TEST, 1):
    path = f"src/write_test_{i:02d}.ts"
    tasks.setdefault("write-test", []).append(make(
        "write-test", i, shape, base({path: content}, {"tests/globals.d.ts": TEST_GLOBALS}),
        {"file": path, "symbol": symbol},
        {"symbol": symbol, "newTestUnder": ["tests/", "__tests__/"]},
    ))

# ---------------------------------------------------------------------------------------------------------------
# fix-test: a test file with a type error in its test body. The runner derives the failure output from the real
# type-check of the test file. The criterion: the test file type-checks after the fix (no test runner exists).
# ---------------------------------------------------------------------------------------------------------------
FIX_TEST = [
    ("wrong-argument-type", "slugify", "slugify lowercases", "slug",
     "export function slugify(title: string): string {\n  return title.trim().toLowerCase().replace(/ /g, \"-\");\n}\n",
     'import { slugify } from "../src/slug";\n\ntest("slugify lowercases", () => {\n  expect(slugify(42)).toBe("42");\n});\n'),
    ("missing-argument", "add", "add sums two numbers", "math",
     "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
     'import { add } from "../src/math";\n\ntest("add sums two numbers", () => {\n  expect(add(1)).toBe(1);\n});\n'),
    ("wrong-property-name", "formatUser", "formats the user name", "users",
     "export function formatUser(user: { name: string; age: number }): string {\n  return `${user.name} (${user.age})`;\n}\n",
     'import { formatUser } from "../src/users";\n\ntest("formats the user name", () => {\n  expect(formatUser({ name: "Ada", age: 36 }).length).toBe(7);\n  const label: string = formatUser({ nmae: "Ada", age: 36 });\n  expect(label).toBe("Ada (36)");\n});\n'),
    ("boolean-as-string", "isEven", "isEven detects even numbers", "parity",
     "export function isEven(n: number): boolean {\n  return n % 2 === 0;\n}\n",
     'import { isEven } from "../src/parity";\n\ntest("isEven detects even numbers", () => {\n  const result: string = isEven(2);\n  expect(result).toBe(true);\n});\n'),
    ("string-for-number", "repeat", "repeat joins copies", "text",
     'export function repeat(text: string, times: number): string {\n  return text.repeat(times);\n}\n',
     'import { repeat } from "../src/text";\n\ntest("repeat joins copies", () => {\n  expect(repeat("ab", "3")).toBe("ababab");\n});\n'),
    ("misspelled-identifier", "median", "median of three", "stats",
     "export function median(values: number[]): number {\n  const sorted = [...values].sort((a, b) => a - b);\n  return sorted[Math.floor(sorted.length / 2)];\n}\n",
     'import { median } from "../src/stats";\n\ntest("median of three", () => {\n  expect(medain([1, 3, 2])).toBe(2);\n});\n'),
    ("wrong-array-type", "total", "total of prices", "cart",
     "export function total(prices: number[]): number {\n  return prices.reduce((sum, p) => sum + p, 0);\n}\n",
     'import { total } from "../src/cart";\n\ntest("total of prices", () => {\n  expect(total("1,2,3")).toBe(6);\n});\n'),
    ("object-literal-shape", "createPoint", "creates a point", "geometry",
     "export function createPoint(x: number, y: number): { x: number; y: number } {\n  return { x, y };\n}\n",
     'import { createPoint } from "../src/geometry";\n\ntest("creates a point", () => {\n  expect(createPoint({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });\n});\n'),
]
for i, (shape, symbol, test_name, module, src, test_src) in enumerate(FIX_TEST, 1):
    src_path = f"src/{module}.ts"
    test_path = f"tests/{module}.test.ts"
    tasks.setdefault("fix-test", []).append(make(
        "fix-test", i, shape,
        base({src_path: src, test_path: test_src}, {"tests/globals.d.ts": TEST_GLOBALS}),
        {"testFile": test_path, "testName": test_name},
        {"typeCheckFile": test_path, "symbol": symbol},
    ))

# ---------------------------------------------------------------------------------------------------------------
# explain: a line range and an optional question. The criterion (recorded in the report, not in the task): the
# cite layer keeps every claim. The task only supplies the code and the range.
# ---------------------------------------------------------------------------------------------------------------
EXPLAIN = [
    ("retry-loop", "src/retry.ts",
     "export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {\n"
     "  let lastError: unknown;\n"
     "  for (let i = 0; i < attempts; i++) {\n"
     "    try {\n"
     "      return await fn();\n"
     "    } catch (error) {\n"
     "      lastError = error;\n"
     "    }\n"
     "  }\n"
     "  throw lastError;\n"
     "}\n",
     "export async function withRetry", None),
    ("cache-get", "src/cache.ts",
     "export class TtlCache<V> {\n"
     "  private entries = new Map<string, { value: V; expires: number }>();\n\n"
     "  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}\n\n"
     "  get(key: string): V | undefined {\n"
     "    const entry = this.entries.get(key);\n"
     "    if (!entry) return undefined;\n"
     "    if (entry.expires <= this.now()) {\n"
     "      this.entries.delete(key);\n"
     "      return undefined;\n"
     "    }\n"
     "    return entry.value;\n"
     "  }\n\n"
     "  set(key: string, value: V): void {\n"
     "    this.entries.set(key, { value, expires: this.now() + this.ttlMs });\n"
     "  }\n"
     "}\n",
     "  get(key: string)", "When does get return undefined?"),
    ("parse-pairs", "src/pairs.ts",
     "export function parsePairs(text: string): Map<string, string> {\n"
     "  const result = new Map<string, string>();\n"
     "  for (const line of text.split(\"\\n\")) {\n"
     "    const [key, ...rest] = line.split(\"=\");\n"
     "    if (!key || rest.length === 0) continue;\n"
     "    result.set(key.trim(), rest.join(\"=\").trim());\n"
     "  }\n"
     "  return result;\n"
     "}\n",
     "export function parsePairs", None),
    ("debounce", "src/debounce.ts",
     "export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {\n"
     "  let timer: ReturnType<typeof setTimeout> | undefined;\n"
     "  return (...args: A): void => {\n"
     "    if (timer !== undefined) clearTimeout(timer);\n"
     "    timer = setTimeout(() => fn(...args), waitMs);\n"
     "  };\n"
     "}\n",
     "export function debounce", "Why is the function returned instead of called?"),
    ("money-format", "src/money.ts",
     "export function formatCents(cents: number, currency = \"USD\"): string {\n"
     "  const negative = cents < 0;\n"
     "  const abs = Math.abs(cents);\n"
     "  const whole = Math.floor(abs / 100);\n"
     "  const frac = String(abs % 100).padStart(2, \"0\");\n"
     "  const text = `${currency} ${whole}.${frac}`;\n"
     "  return negative ? `-${text}` : text;\n"
     "}\n",
     "export function formatCents", None),
    ("queue-drain", "src/queue.ts",
     "export class JobQueue {\n"
     "  private jobs: Array<() => Promise<void>> = [];\n"
     "  private running = false;\n\n"
     "  push(job: () => Promise<void>): void {\n"
     "    this.jobs.push(job);\n"
     "    void this.drain();\n"
     "  }\n\n"
     "  private async drain(): Promise<void> {\n"
     "    if (this.running) return;\n"
     "    this.running = true;\n"
     "    while (this.jobs.length > 0) {\n"
     "      const job = this.jobs.shift();\n"
     "      if (job) await job();\n"
     "    }\n"
     "    this.running = false;\n"
     "  }\n"
     "}\n",
     "  private async drain()", "Can two jobs run at the same time?"),
    ("header-parse", "src/headers.ts",
     "export function parseContentType(value: string): { type: string; charset?: string } {\n"
     "  const [type, ...params] = value.split(\";\").map((part) => part.trim());\n"
     "  const charset = params\n"
     "    .map((param) => param.split(\"=\"))\n"
     "    .find(([name]) => name?.toLowerCase() === \"charset\")?.[1];\n"
     "  return charset ? { type, charset } : { type };\n"
     "}\n",
     "export function parseContentType", None),
    ("range-sum", "src/ranges.ts",
     "export function sumRanges(ranges: Array<[number, number]>): number {\n"
     "  let total = 0;\n"
     "  for (const [start, end] of ranges) {\n"
     "    if (end < start) continue;\n"
     "    total += end - start + 1;\n"
     "  }\n"
     "  return total;\n"
     "}\n",
     "export function sumRanges", "What happens to a range whose end is before its start?"),
]
for i, (shape, path, content, start_marker, question) in enumerate(EXPLAIN, 1):
    start, end = block_range(content, start_marker)
    inp = {"file": path, "startLine": start, "endLine": end}
    if question:
        inp["question"] = question
    tasks.setdefault("explain", []).append(make(
        "explain", i, shape, base({path: content}), inp,
        {"criterion": "cite-layer-keeps-every-claim"},
    ))

# ---------------------------------------------------------------------------------------------------------------
# commit-message: a before state (committed as the seed) and an after state (staged). The criterion: the message
# follows the rules checked by the runner.
# ---------------------------------------------------------------------------------------------------------------
COMMIT = [
    ("add-function",
     {"src/strings.ts": "export function trim(s: string): string {\n  return s.trim();\n}\n"},
     {"src/strings.ts": "export function trim(s: string): string {\n  return s.trim();\n}\n\nexport function capitalize(s: string): string {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}\n"}),
    ("fix-boundary",
     {"src/pages.ts": "export function pageCount(total: number, size: number): number {\n  return Math.floor(total / size);\n}\n"},
     {"src/pages.ts": "export function pageCount(total: number, size: number): number {\n  return Math.ceil(total / size);\n}\n"}),
    ("docs-readme",
     {"README.md": "# tools\n\nSmall helpers.\n"},
     {"README.md": "# tools\n\nSmall helpers.\n\n## Usage\n\nImport the functions from `src/`.\n"}),
    ("add-test",
     {"src/sum.ts": "export function sum(a: number, b: number): number {\n  return a + b;\n}\n"},
     {"src/sum.ts": "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
      "tests/sum.test.ts": "import { sum } from \"../src/sum\";\n\ntest(\"sum\", () => {\n  expect(sum(1, 2)).toBe(3);\n});\n"}),
    ("rename-variable",
     {"src/score.ts": "export function score(points: number[]): number {\n  let s = 0;\n  for (const p of points) s += p;\n  return s;\n}\n"},
     {"src/score.ts": "export function score(points: number[]): number {\n  let total = 0;\n  for (const p of points) total += p;\n  return total;\n}\n"}),
    ("delete-dead-file",
     {"src/old-helpers.ts": "export const unused = 1;\n", "src/main.ts": "export const main = 2;\n"},
     {"src/main.ts": "export const main = 2;\n"}),
    ("bump-config",
     {"config/limits.json": "{\n  \"maxUploadMb\": 10\n}\n"},
     {"config/limits.json": "{\n  \"maxUploadMb\": 25\n}\n"}),
    ("refactor-helper",
     {"src/format.ts": "export function fmt(a: string, b: string): string {\n  return a + \" - \" + b;\n}\n"},
     {"src/format.ts": "export function fmt(a: string, b: string): string {\n  return `${a} - ${b}`;\n}\n"}),
]
for i, (shape, before, after) in enumerate(COMMIT, 1):
    tasks.setdefault("commit-message", []).append(make(
        "commit-message", i, shape, base(after), {}, {"rules": ["type", "header", "subject-length", "no-period", "single-line-subject"]},
        before=base(before),
    ))

# ---------------------------------------------------------------------------------------------------------------
if os.path.isdir(ROOT):
    for recipe in tasks:
        target = os.path.join(ROOT, f"{recipe}-local")
        if os.path.isdir(target):
            shutil.rmtree(target)
total = 0
for recipe, items in tasks.items():
    for t in items:
        write_task(recipe, t)
        total += 1
    print(f"{recipe}: {len(items)} tasks")
print(f"wrote {total} tasks under {ROOT}")
