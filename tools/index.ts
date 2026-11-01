// Barrel exports for the tools module.
// Per PLAN.md §7.1: tool names are Frontal Code tool names with minimum modes.

export {
  TOOL_NAMES,
  TOOL_MIN_MODE,
  TOOL_READ_ONLY,
  TOOL_WRITE,
  TOOL_EXEC,
  DENIED_TOOLS,
  type ToolName,
  isToolDenied,
  toolRequiresApproval,
} from "./tools.js";

export {
  ContextBundleAllowLists,
  EditSchema,
  NewFileSchema,
  buildEditSchema,
  buildEditsSchema,
  buildNewFileSchema,
  buildAnswerSchema,
  buildExplainClaimsSchema,
  buildExplainSchema,
  buildCommitMessageSchema,
  buildImplementSchema,
  buildDocstringSchema,
  buildRenameSchema,
  buildRouterSchema,
  type Edit,
  type Edits,
  type NewFile,
  type Answer,
  type ExplainClaim,
  type ExplainOutput,
  type CommitMessage,
  type ImplementOutput,
  type DocstringOutput,
  type RenameOutput,
  type RouterOutput,
} from "./schema.js";

export {
  Policy,
  PermissionContext,
  checkToolAllowed,
  checkPermissionMode,
  checkModelAllowed,
  checkProviderAllowed,
} from "./policy.js";

export {
  TYPESCRIPT_BUILTINS,
  PYTHON_BUILTINS,
  GO_BUILTINS,
  RUST_BUILTINS,
  BUILTINS_BY_LANG,
  getBuiltins,
} from "./builtins.js";
