export {
  DETECTORS,
  type DetectionReport,
  type Detector,
  type DetectorFailure,
  detectProject,
} from "./detect.ts";
export {
  createFolderFiles,
  createMemoryFiles,
  MAX_READ_BYTES,
  type ProjectFiles,
} from "./files.ts";
export {
  type DetectInput,
  type DetectOutput,
  operations,
  type ProjectServices,
} from "./operations.ts";
export {
  type NodeManagerResolution,
  resolveNodePackageManager,
  scriptArguments,
  scriptCommandText,
} from "./detect-node.ts";
