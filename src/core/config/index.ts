// Core config and templates: the default → derived → project → invocation layers, compare-and-set edits with
// reversible receipts, and the template import/compare/update/remove lifecycle.
export {
  type ConfigApi,
  type ConfigEnvironment,
  createConfig,
  type DetectResult,
  type ExplainResult,
  type Instance,
  type PatchStep,
  type PreviewResult,
  type RevertResult,
  type SaveResult,
  type ShowResult,
  type ValueSource,
  type WriteResult,
} from "./config.ts";
export {
  type BlockConfigSchema,
  type BlockLookup,
  type Change,
  standaloneConfigSchema,
} from "./document.ts";
export type { ConfigFiles } from "./files.ts";
export type { Ignored, Layer, LayerEntry } from "./layers.ts";
export { createConfigOperations, type ConfigOperations } from "./operations.ts";
export { CONFIG_FILE, HISTORY_DIR, LOCK_FILE } from "./store.ts";
export {
  createTemplates,
  type CompareResult,
  type ImportResult,
  type KeyChange,
  type RemoveResult,
  type TemplateApi,
  type TemplateEnvironment,
  type TemplateSource,
  type TemplateSummary,
  TEMPLATE_SKILLS_DIR,
  type UpdateResult,
} from "./templates.ts";
