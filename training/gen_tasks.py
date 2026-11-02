"""Generates fix-diagnostic training, validation and test tasks from template families.

Each task is a tiny TypeScript project with one injected type error, in the same format as
evals/tasks/ts/fix-diagnostic-local/*.json plus `split` and `family` fields.

Split rule (plan section 13.2, 14): split by TEMPLATE FAMILY. A family appears in exactly one split. Identifier
word pools are also disjoint per split, so a test identifier never occurs in training data.

Run: python3 training/gen_tasks.py [--seed 7]
Writes: training/tasks/<split>/<id>.json and training/tasks/manifest.json
"""

import hashlib
import json
import os
import random
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
TASKS = os.path.join(ROOT, "tasks")

TSCONFIG = json.dumps(
    {
        "compilerOptions": {
            "strict": True,
            "target": "ES2022",
            "module": "ESNext",
            "moduleResolution": "bundler",
            "noEmit": True,
        },
        "include": ["src"],
    },
    indent=2,
)

# Identifier word pools. Disjoint between splits on purpose.
POOLS = {
    "train": ["invoice", "ledger", "tally", "sprocket", "widget", "gadget", "harbor", "meadow", "cobalt",
              "ember", "pulley", "thimble", "bobbin", "cistern", "dynamo", "fennel"],
    "validation": ["basket", "canvas", "lantern", "orbit", "pillar", "quartz", "raven", "saddle", "timber",
                   "vortex", "falcon", "spindle", "gravel", "hinge", "mosaic", "parcel"],
    "test": ["glacier", "hammock", "island", "jigsaw", "kettle", "lattice", "marble", "nectar", "oyster",
             "pepper", "quiver", "tundra", "walnut", "yarrow", "zephyr", "beacon"],
}

SPLIT_OF_FAMILY = {
    # annotation-mismatch
    "ann-literal-number": "train",
    "ann-object-field": "train",
    "ann-string-from-number": "train",
    "ann-boolean": "validation",
    "ann-array-of-numbers": "test",
    "ann-union-mismatch": "test",
    # misspelled-name
    "typo-local-const": "train",
    "typo-function-call": "train",
    "typo-property": "train",
    "typo-parameter": "validation",
    "typo-imported-usage": "test",
    "typo-type-name": "test",
    # missing-import
    "imp-function-helper": "train",
    "imp-type-interface": "train",
    "imp-const-config": "train",
    "imp-class": "validation",
    "imp-nested-dir": "test",
    "imp-default-export": "test",
    # return-type
    "ret-string-from-number": "train",
    "ret-number-from-string": "train",
    "ret-object-shape": "train",
    "ret-promise": "validation",
    "ret-boolean": "test",
    "ret-array": "test",
    # argument-type
    "arg-number-as-string": "train",
    "arg-string-as-number": "train",
    "arg-second-param": "train",
    "arg-object-field": "validation",
    "arg-boolean-from-string": "test",
    "arg-array-from-string": "test",
    # Attempt 2 (training/reports/attempt2-protocol.md). Train-assigned new families.
    "ann-tuple-length": "train",
    "ann-record-value": "train",
    "ann-nested-array": "train",
    "ann-optional-union": "train",
    "typo-enum-member": "train",
    "typo-array-method": "train",
    "imp-type-alias": "train",
    "imp-enum-member": "train",
    "ret-void-value": "train",
    "ret-union-literal": "train",
    "ret-optional-undefined": "train",
    "arg-callback-return": "train",
    # Attempt 2. Validation-assigned new families.
    "typo-object-method": "validation",
    "imp-generic-type": "validation",
    "arg-object-second-field": "validation",
}

PER_SPLIT_INSTANCES = {"train": 60, "validation": 12, "test": 15}  # attempt 2: train 20 -> 60 per family


class Ctx:
    def __init__(self, rng, pool):
        self.rng = rng
        self.pool = pool

    def word(self):
        return self.rng.choice(self.pool)

    def ident(self, *parts):
        # camelCase from pool words, e.g. ident() -> "emberTundra"
        words = [self.word()] if not parts else list(parts)
        out = words[0]
        for w in words[1:]:
            out += w[:1].upper() + w[1:]
        return out + str(self.rng.randint(1, 99))

    def type_name(self):
        w = self.word()
        return w[:1].upper() + w[1:] + str(self.rng.randint(1, 99))

    def num(self):
        return self.rng.randint(2, 999)

    def text(self):
        return self.word() + str(self.rng.randint(1, 99))

    def typo(self, name):
        # Swap two adjacent characters so the name actually changes (swapping equal letters would not).
        for _ in range(20):
            i = self.rng.randint(1, len(name) - 3)
            candidate = name[:i] + name[i + 1] + name[i] + name[i + 2:]
            if candidate != name:
                return candidate
        return name + "x"


# Each builder returns (files, error_file, error_line_index_0based). `files` maps path to lines.
def fam_ann_literal_number(c):
    v, s = c.ident(), c.text()
    return {"src/a.ts": [f'export const {v}: number = "{s}";']}, "src/a.ts", 0


def fam_ann_object_field(c):
    v, f, n = c.ident(), c.word(), c.num()
    return {"src/a.ts": [f'export const {v}: {{ {f}: number }} = {{ {f}: "{n}" }};']}, "src/a.ts", 0


def fam_ann_string_from_number(c):
    v, w, n = c.ident(), c.ident(), c.num()
    return {"src/a.ts": [f"const {v}: string = {n} * 2;", f"export const {w} = {v}.length;"]}, "src/a.ts", 0


def fam_ann_boolean(c):
    v, n = c.ident(), c.num()
    return {"src/a.ts": [f"export const {v}: boolean = {n};"]}, "src/a.ts", 0


def fam_ann_array_of_numbers(c):
    v, a, b = c.ident(), c.text(), c.text()
    return {"src/a.ts": [f'export const {v}: number[] = ["{a}", "{b}"];']}, "src/a.ts", 0


def fam_ann_union_mismatch(c):
    v, x = c.ident(), c.text()
    return {"src/a.ts": [f'export const {v}: "on" | "off" = "{x}";']}, "src/a.ts", 0


def fam_typo_local_const(c):
    v, w, n = c.ident(), c.ident(), c.num()
    return {"src/a.ts": [f"const {v} = {n};", f"export const {w} = {c.typo(v)} + 1;"]}, "src/a.ts", 1


def fam_typo_function_call(c):
    fn, w, n = c.ident(), c.ident(), c.num()
    return {"src/a.ts": [f"export function {fn}(x: number): number {{", "  return x * 2;", "}",
                         f"export const {w} = {c.typo(fn)}({n});"]}, "src/a.ts", 3


def fam_typo_property(c):
    cfg, p, w, n = c.ident(), c.word(), c.ident(), c.num()
    return {"src/a.ts": [f"const {cfg} = {{ {p}: {n} }};", f"export const {w} = {cfg}.{c.typo(p)};"]}, "src/a.ts", 1


def fam_typo_parameter(c):
    fn, a, b = c.ident(), c.word(), c.word()
    while b == a:
        b = c.word()
    return {"src/a.ts": [f"export function {fn}({a}: number, {b}: number): number {{",
                         f"  return {c.typo(a)} + {b};", "}"]}, "src/a.ts", 1


def fam_typo_imported_usage(c):
    fn, w = c.ident(), c.ident()
    util = [f"export function {fn}(s: string): string {{", "  return s.trim();", "}"]
    a = [f"import {{ {fn} }} from \"./util\";", f'export const {w} = {c.typo(fn)}(" x ");']
    return {"src/util.ts": util, "src/a.ts": a}, "src/a.ts", 1


def fam_typo_type_name(c):
    T, f, v, n = c.type_name(), c.word(), c.ident(), c.num()
    return {"src/a.ts": [f"interface {T} {{ {f}: number; }}", f"const {v}: {c.typo(T)} = {{ {f}: {n} }};",
                         f"export const out = {v};"]}, "src/a.ts", 1


def fam_imp_function_helper(c):
    fn, w, n = c.ident(), c.ident(), c.num()
    return {"src/helper.ts": [f"export function {fn}(): number {{", f"  return {n};", "}"],
            "src/a.ts": [f"export const {w}: number = {fn}();"]}, "src/a.ts", 0


def fam_imp_type_interface(c):
    T, f, g = c.type_name(), c.word(), c.ident()
    return {"src/types.ts": [f"export interface {T} {{ {f}: number; }}"],
            "src/a.ts": [f"export function {g}(p: {T}): number {{", f"  return p.{f};", "}"]}, "src/a.ts", 0


def fam_imp_const_config(c):
    K, w, n = c.ident().upper(), c.ident(), c.num()
    return {"src/config.ts": [f"export const {K} = {n};"],
            "src/a.ts": [f"export const {w} = {K} + 1;"]}, "src/a.ts", 0


def fam_imp_class(c):
    C, w, n = c.type_name(), c.ident(), c.num()
    return {"src/cache.ts": [f"export class {C} {{", f"  size = {n};", "}"],
            "src/a.ts": [f"export const {w} = new {C}().size;"]}, "src/a.ts", 0


def fam_imp_nested_dir(c):
    fn, w, n = c.ident(), c.ident(), c.num()
    return {"src/lib/math.ts": [f"export function {fn}(x: number): number {{ return x; }}"],
            "src/app/main.ts": [f"export const {w} = {fn}({n});"]}, "src/app/main.ts", 0


def fam_imp_default_export(c):
    fn, w, s = c.ident(), c.ident(), c.text()
    return {"src/greet.ts": [f'export default function {fn}(): string {{ return "{s}"; }}'],
            "src/a.ts": [f"export const {w} = {fn}();"]}, "src/a.ts", 0


def fam_ret_string_from_number(c):
    fn, n = c.ident(), c.num()
    return {"src/a.ts": [f"export function {fn}(): string {{", f"  return {n};", "}"]}, "src/a.ts", 1


def fam_ret_number_from_string(c):
    fn = c.ident()
    return {"src/a.ts": [f"export function {fn}(s: string): number {{", "  return s;", "}"]}, "src/a.ts", 1


def fam_ret_object_shape(c):
    fn, s = c.ident(), c.text()
    return {"src/a.ts": [f"export function {fn}(): {{ id: number }} {{", f'  return {{ id: "{s}" }};', "}"]}, "src/a.ts", 1


def fam_ret_promise(c):
    fn, s = c.ident(), c.text()
    return {"src/a.ts": [f"export async function {fn}(): Promise<number> {{", f'  return "{s}";', "}"]}, "src/a.ts", 1


def fam_ret_boolean(c):
    fn = c.ident()
    return {"src/a.ts": [f"export function {fn}(n: number): boolean {{", "  return n;", "}"]}, "src/a.ts", 1


def fam_ret_array(c):
    fn, n = c.ident(), c.num()
    return {"src/a.ts": [f"export function {fn}(): string[] {{", f"  return {n};", "}"]}, "src/a.ts", 1


def fam_arg_number_as_string(c):
    fn, w, n = c.ident(), c.ident(), c.num()
    return {"src/a.ts": [f"function {fn}(n: number): number {{", "  return n * 2;", "}",
                         f'export const {w} = {fn}("{n}");']}, "src/a.ts", 3


def fam_arg_string_as_number(c):
    fn, w, n = c.ident(), c.ident(), c.num()
    return {"src/a.ts": [f"function {fn}(name: string): string {{", "  return name.trim();", "}",
                         f"export const {w} = {fn}({n});"]}, "src/a.ts", 3


def fam_arg_second_param(c):
    fn, w, s, n = c.ident(), c.ident(), c.text(), c.num()
    return {"src/a.ts": [f"function {fn}(s: string, width: number): string {{", "  return s.padStart(width);", "}",
                         f'export const {w} = {fn}("{s}", "{n}");']}, "src/a.ts", 3


def fam_arg_object_field(c):
    T, fn, w, s = c.type_name(), c.ident(), c.ident(), c.text()
    return {"src/a.ts": [f"interface {T} {{ id: number; }}", f"function {fn}(u: {T}): number {{", "  return u.id;",
                         "}", f'export const {w} = {fn}({{ id: "{s}" }});']}, "src/a.ts", 4


def fam_arg_boolean_from_string(c):
    fn, w, s = c.ident(), c.ident(), c.text()
    return {"src/a.ts": [f"function {fn}(on: boolean): string {{", '  return on ? "y" : "n";', "}",
                         f'export const {w} = {fn}("{s}");']}, "src/a.ts", 3


def fam_arg_array_from_string(c):
    fn, w, s = c.ident(), c.ident(), c.text()
    return {"src/a.ts": [f"function {fn}(xs: number[]): number {{", "  return xs.length;", "}",
                         f'export const {w} = {fn}("{s}");']}, "src/a.ts", 3


# Attempt 2 families (plan 13.2, training/reports/attempt2-protocol.md). Train-assigned families use the train pool,
# validation-assigned families use the validation pool. Neither pool contains a test word.
def fam_ann_tuple_length(c):
    v, a, b, d = c.ident(), c.num(), c.num(), c.num()
    return {"src/a.ts": [f"export const {v}: [number, number] = [{a}, {b}, {d}];"]}, "src/a.ts", 0


def fam_ann_record_value(c):
    v, k, s = c.ident(), c.word(), c.text()
    return {"src/a.ts": [f'export const {v}: Record<string, number> = {{ {k}: "{s}" }};']}, "src/a.ts", 0


def fam_ann_nested_array(c):
    v, n, s = c.ident(), c.num(), c.text()
    return {"src/a.ts": [f'export const {v}: number[][] = [[{n}], ["{s}"]];']}, "src/a.ts", 0


def fam_ann_optional_union(c):
    v, n = c.ident(), c.num()
    return {"src/a.ts": [f"export const {v}: string | undefined = {n};"]}, "src/a.ts", 0


def fam_typo_enum_member(c):
    E, m, o, w = c.type_name(), c.word(), c.word(), c.ident()
    while o == m:
        o = c.word()
    M, O = m[:1].upper() + m[1:], o[:1].upper() + o[1:]
    return {"src/a.ts": [f"export enum {E} {{ {M} = 1, {O} = 2 }}",
                         f"export const {w} = {E}.{c.typo(M)};"]}, "src/a.ts", 1


def fam_typo_array_method(c):
    v, w, n = c.ident(), c.ident(), c.num()
    return {"src/a.ts": [f"const {v} = [{n}, 2, 3];", f"export const {w} = {v}.{c.typo('length')};"]}, "src/a.ts", 1


def fam_imp_type_alias(c):
    T, f, g = c.type_name(), c.word(), c.ident()
    return {"src/types.ts": [f"export type {T} = {{ {f}: number }};"],
            "src/a.ts": [f"export function {g}(p: {T}): number {{", f"  return p.{f};", "}"]}, "src/a.ts", 0


def fam_imp_enum_member(c):
    E, m, w = c.type_name(), c.word(), c.ident()
    M = m[:1].upper() + m[1:]
    return {"src/codes.ts": [f"export enum {E} {{ {M} = 3 }}"],
            "src/a.ts": [f"export const {w} = {E}.{M};"]}, "src/a.ts", 0


def fam_ret_void_value(c):
    fn, n = c.ident(), c.num()
    return {"src/a.ts": [f"export function {fn}(): void {{", f"  return {n};", "}"]}, "src/a.ts", 1


def fam_ret_union_literal(c):
    fn, s = c.ident(), c.text()
    return {"src/a.ts": [f'export function {fn}(flag: boolean): "on" | "off" {{', f'  return flag ? "on" : "{s}";',
                         "}"]}, "src/a.ts", 1


def fam_ret_optional_undefined(c):
    fn, n = c.ident(), c.num()
    return {"src/a.ts": [f"export function {fn}(x: number): number {{", f"  if (x > {n}) return x;",
                         "  return undefined;", "}"]}, "src/a.ts", 2


def fam_arg_callback_return(c):
    fn, w, n, s = c.ident(), c.ident(), c.num(), c.text()
    return {"src/a.ts": [f"function {fn}(cb: (x: number) => number): number {{", f"  return cb({n});", "}",
                         f'export const {w} = {fn}((x: number) => "{s}");']}, "src/a.ts", 3


def fam_typo_object_method(c):
    o, m, w, n = c.ident(), c.word(), c.ident(), c.num()
    return {"src/a.ts": [f"const {o} = {{ {m}(): number {{ return {n}; }} }};",
                         f"export const {w} = {o}.{c.typo(m)}();"]}, "src/a.ts", 1


def fam_imp_generic_type(c):
    B, f, w, n = c.type_name(), c.word(), c.ident(), c.num()
    return {"src/box.ts": [f"export interface {B}<T> {{ {f}: T; }}"],
            "src/a.ts": [f"export const {w}: {B}<number> = {{ {f}: {n} }};"]}, "src/a.ts", 0


def fam_arg_object_second_field(c):
    T, fn, w, n = c.type_name(), c.ident(), c.ident(), c.num()
    return {"src/a.ts": [f"interface {T} {{ id: number; name: string; }}", f"function {fn}(u: {T}): string {{",
                         "  return u.name;", "}", f"export const {w} = {fn}({{ id: {n}, name: {n} }});"]}, "src/a.ts", 4


FAMILIES = {
    "ann-literal-number": ("annotation-mismatch", fam_ann_literal_number),
    "ann-object-field": ("annotation-mismatch", fam_ann_object_field),
    "ann-string-from-number": ("annotation-mismatch", fam_ann_string_from_number),
    "ann-boolean": ("annotation-mismatch", fam_ann_boolean),
    "ann-array-of-numbers": ("annotation-mismatch", fam_ann_array_of_numbers),
    "ann-union-mismatch": ("annotation-mismatch", fam_ann_union_mismatch),
    "typo-local-const": ("misspelled-name", fam_typo_local_const),
    "typo-function-call": ("misspelled-name", fam_typo_function_call),
    "typo-property": ("misspelled-name", fam_typo_property),
    "typo-parameter": ("misspelled-name", fam_typo_parameter),
    "typo-imported-usage": ("misspelled-name", fam_typo_imported_usage),
    "typo-type-name": ("misspelled-name", fam_typo_type_name),
    "imp-function-helper": ("missing-import", fam_imp_function_helper),
    "imp-type-interface": ("missing-import", fam_imp_type_interface),
    "imp-const-config": ("missing-import", fam_imp_const_config),
    "imp-class": ("missing-import", fam_imp_class),
    "imp-nested-dir": ("missing-import", fam_imp_nested_dir),
    "imp-default-export": ("missing-import", fam_imp_default_export),
    "ret-string-from-number": ("return-type", fam_ret_string_from_number),
    "ret-number-from-string": ("return-type", fam_ret_number_from_string),
    "ret-object-shape": ("return-type", fam_ret_object_shape),
    "ret-promise": ("return-type", fam_ret_promise),
    "ret-boolean": ("return-type", fam_ret_boolean),
    "ret-array": ("return-type", fam_ret_array),
    "arg-number-as-string": ("argument-type", fam_arg_number_as_string),
    "arg-string-as-number": ("argument-type", fam_arg_string_as_number),
    "arg-second-param": ("argument-type", fam_arg_second_param),
    "arg-object-field": ("argument-type", fam_arg_object_field),
    "arg-boolean-from-string": ("argument-type", fam_arg_boolean_from_string),
    "arg-array-from-string": ("argument-type", fam_arg_array_from_string),
    "ann-tuple-length": ("annotation-mismatch", fam_ann_tuple_length),
    "ann-record-value": ("annotation-mismatch", fam_ann_record_value),
    "ann-nested-array": ("annotation-mismatch", fam_ann_nested_array),
    "ann-optional-union": ("annotation-mismatch", fam_ann_optional_union),
    "typo-enum-member": ("misspelled-name", fam_typo_enum_member),
    "typo-array-method": ("misspelled-name", fam_typo_array_method),
    "typo-object-method": ("misspelled-name", fam_typo_object_method),
    "imp-type-alias": ("missing-import", fam_imp_type_alias),
    "imp-enum-member": ("missing-import", fam_imp_enum_member),
    "imp-generic-type": ("missing-import", fam_imp_generic_type),
    "ret-void-value": ("return-type", fam_ret_void_value),
    "ret-union-literal": ("return-type", fam_ret_union_literal),
    "ret-optional-undefined": ("return-type", fam_ret_optional_undefined),
    "arg-callback-return": ("argument-type", fam_arg_callback_return),
    "arg-object-second-field": ("argument-type", fam_arg_object_second_field),
}


def build_task(split, family, index, rng):
    category, builder = FAMILIES[family]
    ctx = Ctx(rng, POOLS[split])
    files, error_file, error_idx = builder(ctx)
    rendered = {"tsconfig.json": TSCONFIG}
    for path, lines in files.items():
        rendered[path] = "\n".join(lines) + "\n"
    tid = f"{split}-{family}-{index:03d}"
    return {
        "id": tid,
        "split": split,
        "family": family,
        "category": category,
        "mutation": True,
        "files": rendered,
        "target": f"{error_file}:{error_idx + 1}",
        "check": "no-type-errors-in-target-file",
    }


def main():
    seed = 7
    if "--seed" in sys.argv:
        seed = int(sys.argv[sys.argv.index("--seed") + 1])
    # Sanity: every family is assigned to exactly one split, and the pools are disjoint.
    assert set(SPLIT_OF_FAMILY) == set(FAMILIES), "family/split table out of sync"
    all_words = [set(p) for p in POOLS.values()]
    assert not (all_words[0] & all_words[1]) and not (all_words[0] & all_words[2]) and not (all_words[1] & all_words[2])

    splits = ("train", "validation")
    if "--splits" in sys.argv:
        splits = tuple(sys.argv[sys.argv.index("--splits") + 1].split(","))
    assert "test" not in splits, "the test split is fixed; it is never regenerated (attempt 2 protocol section 1)"
    manifest_path = os.path.join(TASKS, "manifest.json")
    manifest = {"seed": seed, "splits": {}, "families": {}}
    if os.path.isfile(manifest_path):
        with open(manifest_path) as fh:
            old = json.load(fh)
        manifest["splits"] = {k: v for k, v in old.get("splits", {}).items() if k not in splits}
        manifest["families"] = {k: v for k, v in old.get("families", {}).items() if v["split"] not in splits}
    seen_hashes = set()
    for split in splits:
        if os.path.isdir(os.path.join(TASKS, split)):
            shutil.rmtree(os.path.join(TASKS, split))
        rng = random.Random(f"{seed}-{split}")
        split_dir = os.path.join(TASKS, split)
        os.makedirs(split_dir, exist_ok=True)
        families = [f for f, s in SPLIT_OF_FAMILY.items() if s == split]
        count = 0
        for family in families:
            made = 0
            index = 1
            while made < PER_SPLIT_INSTANCES[split]:
                task = build_task(split, family, index, rng)
                index += 1
                digest = hashlib.sha256(json.dumps(task["files"], sort_keys=True).encode()).hexdigest()
                if digest in seen_hashes:
                    continue
                seen_hashes.add(digest)
                with open(os.path.join(split_dir, f"{task['id']}.json"), "w") as fh:
                    json.dump(task, fh, indent=2)
                    fh.write("\n")
                made += 1
                count += 1
            manifest["families"][family] = {"split": split, "category": FAMILIES[family][0], "tasks": made}
        manifest["splits"][split] = {"tasks": count, "families": families}
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    for split in splits:
        info = manifest["splits"][split]
        print(f"{split}: {info['tasks']} tasks, {len(info['families'])} families")


if __name__ == "__main__":
    main()
