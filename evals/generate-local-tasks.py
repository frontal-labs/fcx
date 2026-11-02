"""Generates self-contained fix-diagnostic eval tasks (mutation-generated, tagged as such).

Each task inlines a tiny TypeScript project with one injected error. The runner materializes it into a
temp directory, runs fcx fix on the target line, and checks that the file then has no type errors.
Run: python3 evals/generate-local-tasks.py
"""
import json, os

OUT = os.path.join(os.path.dirname(__file__), "tasks", "ts", "fix-diagnostic-local")
TSCONFIG = json.dumps({"compilerOptions": {"strict": True, "target": "ES2022", "module": "ESNext",
                                           "moduleResolution": "bundler", "noEmit": True},
                       "include": ["src"]}, indent=2)

def task(tid, category, files, target):
    return {"id": tid, "category": category, "mutation": True, "files": {"tsconfig.json": TSCONFIG, **files},
            "target": target, "check": "no-type-errors-in-target-file"}

tasks = []
for i in range(1, 4):
    # 1. Wrong literal type: the model must change the value or the annotation.
    tasks.append(task(f"annotation-{i}", "annotation-mismatch", {
        "src/a.ts": f'export const count{i}: number = "{i + 4}";\n'}, "src/a.ts:1"))
    # 2. Missing import: the compiler's quick fix should handle it without the model.
    tasks.append(task(f"missing-import-{i}", "missing-import", {
        "src/helper.ts": f"export function helper{i}(): number {{\n  return {i};\n}}\n",
        "src/a.ts": f"export const value{i}: number = helper{i}();\n"}, "src/a.ts:1"))
    # 3. Misspelled identifier: the compiler's spelling suggestion.
    tasks.append(task(f"typo-{i}", "misspelled-name", {
        "src/a.ts": f"const total{i} = {i};\nexport const result{i} = totl{i} + 1;\n"}, "src/a.ts:2"))
    # 4. Wrong return type: the model must reconcile the value and the annotation.
    tasks.append(task(f"return-type-{i}", "return-type", {
        "src/a.ts": f'export function label{i}(): string {{\n  return {i * 10};\n}}\n'}, "src/a.ts:2"))

os.makedirs(OUT, exist_ok=True)
for t in tasks:
    with open(os.path.join(OUT, f"{t['id']}.json"), "w") as fh:
        json.dump(t, fh, indent=2)
        fh.write("\n")
print(f"wrote {len(tasks)} tasks to {OUT}")
