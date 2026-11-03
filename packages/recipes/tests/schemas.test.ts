import { describe, expect, it } from "vitest";
import * as z from "zod";
import { AddTypesSchema } from "../src/recipes/add-types.js";
import { CommitMessageSchema } from "../src/recipes/commit-message.js";
import { DocstringSchema } from "../src/recipes/docstring.js";
import { ExplainSchema } from "../src/recipes/explain.js";
import { FixTestSchema } from "../src/recipes/fix-test.js";
import { ImplementSchema } from "../src/recipes/implement.js";
import { RefactorSmallSchema } from "../src/recipes/refactor-small.js";
import { RenameSchema } from "../src/recipes/rename-extract.js";
import { WriteTestSchema } from "../src/recipes/write-test.js";

// The model is constrained by each schema converted to JSON Schema. A schema that cannot convert (for example one
// with a transform) breaks every candidate for its recipe, and the canned-output tests never notice.
const SCHEMAS: Record<string, z.ZodType> = {
  AddTypesSchema,
  CommitMessageSchema,
  DocstringSchema,
  ExplainSchema,
  FixTestSchema,
  ImplementSchema,
  RefactorSmallSchema,
  RenameSchema,
  WriteTestSchema,
};

describe("recipe output schemas", () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name} converts to JSON Schema`, () => {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    });
  }
});
