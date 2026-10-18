export { Runtime, type RuntimeOptions } from "../core/runtime/index.ts";
export { BlockCatalog } from "../core/runtime/catalog.ts";
export {
  Catalog,
  captureBlock,
  addBlock,
  type CaptureLimits,
} from "../core/catalog/index.ts";
export { TrustStore } from "../core/trust/index.ts";
export { nodeFileCapture } from "../adapters/node-runtime/capture.ts";
export { nodeRunIsolation } from "../adapters/node-runtime/isolation.ts";
export { createNodeBlockCatalog } from "../adapters/node-runtime/catalog.ts";

export {
  createAssembly,
  localContext,
  type Assembly,
  type AssemblyOptions,
} from "./index.ts";
