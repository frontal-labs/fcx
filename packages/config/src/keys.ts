import * as z from "zod";

/**
 * Environment keys read by the config resolver. Values are only shape-checked
 * here. Permission-mode validation happens in the resolver, where unrecognized
 * values are reported and ignored (never treated as permissive, plan §5.2).
 *
 * Parsed per call, not at import, so callers and tests can change `process.env`
 * between resolutions.
 */
const envSchema = z.object({
  HOME: z
    .string()
    .optional()
    .transform((value) => value ?? "/"),
  FRONTAL_CODE_CONFIG_HOME: z.string().optional(),
  FRONTAL_CODE_HOME: z.string().optional(),
  FRONTAL_CODE_CACHE_DIR: z.string().optional(),
  FRONTAL_CODE_LOGS_DIR: z.string().optional(),
  FRONTAL_API_KEY: z.string().optional(),
  FRONTAL_BASE_URL: z.string().optional(),
  FRONTAL_CODE_ENABLE_TELEMETRY: z
    .string()
    .optional()
    .transform((value): boolean | "inherit" => {
      if (value === "true") return true;
      if (value === "false") return false;
      return "inherit";
    }),
});

export type Env = z.infer<typeof envSchema>;

export function readEnv(runtimeEnv: NodeJS.ProcessEnv = process.env): Env {
  const picked: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = runtimeEnv[key];
    picked[key] = value === "" ? undefined : value;
  }
  return envSchema.parse(picked);
}
