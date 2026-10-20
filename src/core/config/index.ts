// Core config and templates: the default → derived → project → invocation layers, compare-and-set
// edits, and templates that import as a plain copy and remove only what they wrote unchanged.
export {
  type ConfigApi,
  type ConfigEnvironment,
  createConfig,
  type DetectResult,
  type ExplainResult,
  type Instance,
  type PatchStep,
  type PreviewResult,
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
export { CONFIG_FILE, LOCK_FILE } from "./store.ts";
export {
  createTemplates,
  type ImportResult,
  type KeptKey,
  type RemoveResult,
  type TemplateApi,
  type TemplateEnvironment,
  type TemplateSource,
  type TemplateSummary,
} from "./templates.ts";
