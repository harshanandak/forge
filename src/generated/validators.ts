// Generated from schemas/ by tools/gen/types.ts. Do not edit; regenerate instead.

import { SchemaRegistry, type Validator } from "../contract/schema.ts";
import { SCHEMA_BASE } from "../contract/documents.ts";
import { SCHEMA_DOCUMENTS } from "./schemas.ts";
import type {
  BlockManifest,
  ExecutionProfile,
  NounDeclaration,
  ProvidedInterface,
  RequiredSlot,
  Segment,
  Publisher,
  BlockId,
  Noun,
  Verb,
  OperationName,
  McpToolName,
  InstanceName,
  PropertyName,
  ErrorCode,
  EffectName,
  EventType,
  PermissionKey,
  SemVer,
  VersionRange,
  InterfaceId,
  InterfaceRef,
  InterfaceVersionRef,
  TemplateRef,
  Digest,
  Timestamp,
  RequestId,
  JsonPointer,
  RelativePath,
  Caller,
  Stability,
  ContextVariant,
  LeaseMode,
  SecretRef,
  Unavailable,
  ParseLimits,
  UntrustedContent,
  ConfigDocument,
  BlockInstance,
  BindingTarget,
  BlockSource,
  BuiltinSource,
  PathSource,
  PackageSource,
  McpExposure,
  ExposureSelector,
  TemplateProvenance,
  KeyOwner,
  Actor,
  DeviceScope,
  ProjectIdentity,
  Session,
  AmbientContext,
  StatelessContext,
  DeviceContext,
  ProjectContext,
  LeaseAcquireContext,
  LeaseHeldContext,
  BoundContext,
  DetectionObservation,
  DetectionOrigin,
  DocsRecords,
  OperationDocs,
  Example,
  ForgeError,
  CoreErrorCode,
  RetryPosture,
  ContextField,
  LeaseConflict,
  Evidence,
  EvidenceStatus,
  CheckItem,
  InterfaceDocument,
  SchemaRef,
  InterfaceOperation,
  InvocationRequest,
  ExecutionObservation,
  ExecutionStatus,
  LimitHit,
  EffectOutcome,
  EffectObservation,
  OperationDeclaration,
  Deprecation,
  McpToolAnnotations,
  McpTool,
  ResultEnvelope,
  SuccessEnvelope,
  FailureEnvelope,
  Warning,
  StateRecord,
  StateEvent,
  LeaseHolder,
  LeaseRecord,
  TemplateDocument,
  ItemId,
  ItemStatus,
  TrackerItem,
  CreateItemInput,
  ItemRef,
  ListItemsInput,
  ListItemsOutput,
  UpdateItemInput,
  CommentInput,
  CommentOutput,
  ClaimInput,
  LeaseGrant,
  CloseInput,
} from "./types.ts";

/** The registry of every Forge schema; short references resolve against schemas/. */
export const registry: SchemaRegistry = new SchemaRegistry(
  SCHEMA_DOCUMENTS,
  SCHEMA_BASE,
);

export const validateBlockManifest: Validator<BlockManifest> =
  registry.validator("block.json");

export const validateExecutionProfile: Validator<ExecutionProfile> =
  registry.validator("block.json#/$defs/ExecutionProfile");

export const validateNounDeclaration: Validator<NounDeclaration> =
  registry.validator("block.json#/$defs/NounDeclaration");

export const validateProvidedInterface: Validator<ProvidedInterface> =
  registry.validator("block.json#/$defs/ProvidedInterface");

export const validateRequiredSlot: Validator<RequiredSlot> = registry.validator(
  "block.json#/$defs/RequiredSlot",
);

export const validateSegment: Validator<Segment> = registry.validator(
  "common.json#/$defs/Segment",
);

export const validatePublisher: Validator<Publisher> = registry.validator(
  "common.json#/$defs/Publisher",
);

export const validateBlockId: Validator<BlockId> = registry.validator(
  "common.json#/$defs/BlockId",
);

export const validateNoun: Validator<Noun> = registry.validator(
  "common.json#/$defs/Noun",
);

export const validateVerb: Validator<Verb> = registry.validator(
  "common.json#/$defs/Verb",
);

export const validateOperationName: Validator<OperationName> =
  registry.validator("common.json#/$defs/OperationName");

export const validateMcpToolName: Validator<McpToolName> = registry.validator(
  "common.json#/$defs/McpToolName",
);

export const validateInstanceName: Validator<InstanceName> = registry.validator(
  "common.json#/$defs/InstanceName",
);

export const validatePropertyName: Validator<PropertyName> = registry.validator(
  "common.json#/$defs/PropertyName",
);

export const validateErrorCode: Validator<ErrorCode> = registry.validator(
  "common.json#/$defs/ErrorCode",
);

export const validateEffectName: Validator<EffectName> = registry.validator(
  "common.json#/$defs/EffectName",
);

export const validateEventType: Validator<EventType> = registry.validator(
  "common.json#/$defs/EventType",
);

export const validatePermissionKey: Validator<PermissionKey> =
  registry.validator("common.json#/$defs/PermissionKey");

export const validateSemVer: Validator<SemVer> = registry.validator(
  "common.json#/$defs/SemVer",
);

export const validateVersionRange: Validator<VersionRange> = registry.validator(
  "common.json#/$defs/VersionRange",
);

export const validateInterfaceId: Validator<InterfaceId> = registry.validator(
  "common.json#/$defs/InterfaceId",
);

export const validateInterfaceRef: Validator<InterfaceRef> = registry.validator(
  "common.json#/$defs/InterfaceRef",
);

export const validateInterfaceVersionRef: Validator<InterfaceVersionRef> =
  registry.validator("common.json#/$defs/InterfaceVersionRef");

export const validateTemplateRef: Validator<TemplateRef> = registry.validator(
  "common.json#/$defs/TemplateRef",
);

export const validateDigest: Validator<Digest> = registry.validator(
  "common.json#/$defs/Digest",
);

export const validateTimestamp: Validator<Timestamp> = registry.validator(
  "common.json#/$defs/Timestamp",
);

export const validateRequestId: Validator<RequestId> = registry.validator(
  "common.json#/$defs/RequestId",
);

export const validateJsonPointer: Validator<JsonPointer> = registry.validator(
  "common.json#/$defs/JsonPointer",
);

export const validateRelativePath: Validator<RelativePath> = registry.validator(
  "common.json#/$defs/RelativePath",
);

export const validateCaller: Validator<Caller> = registry.validator(
  "common.json#/$defs/Caller",
);

export const validateStability: Validator<Stability> = registry.validator(
  "common.json#/$defs/Stability",
);

export const validateContextVariant: Validator<ContextVariant> =
  registry.validator("common.json#/$defs/ContextVariant");

export const validateLeaseMode: Validator<LeaseMode> = registry.validator(
  "common.json#/$defs/LeaseMode",
);

export const validateSecretRef: Validator<SecretRef> = registry.validator(
  "common.json#/$defs/SecretRef",
);

export const validateUnavailable: Validator<Unavailable> = registry.validator(
  "common.json#/$defs/Unavailable",
);

export const validateParseLimits: Validator<ParseLimits> = registry.validator(
  "common.json#/$defs/ParseLimits",
);

export const validateUntrustedContent: Validator<UntrustedContent> =
  registry.validator("common.json#/$defs/UntrustedContent");

export const validateConfigDocument: Validator<ConfigDocument> =
  registry.validator("config.json");

export const validateBlockInstance: Validator<BlockInstance> =
  registry.validator("config.json#/$defs/BlockInstance");

export const validateBindingTarget: Validator<BindingTarget> =
  registry.validator("config.json#/$defs/BindingTarget");

export const validateBlockSource: Validator<BlockSource> = registry.validator(
  "config.json#/$defs/BlockSource",
);

export const validateBuiltinSource: Validator<BuiltinSource> =
  registry.validator("config.json#/$defs/BuiltinSource");

export const validatePathSource: Validator<PathSource> = registry.validator(
  "config.json#/$defs/PathSource",
);

export const validatePackageSource: Validator<PackageSource> =
  registry.validator("config.json#/$defs/PackageSource");

export const validateMcpExposure: Validator<McpExposure> = registry.validator(
  "config.json#/$defs/McpExposure",
);

export const validateExposureSelector: Validator<ExposureSelector> =
  registry.validator("config.json#/$defs/ExposureSelector");

export const validateTemplateProvenance: Validator<TemplateProvenance> =
  registry.validator("config.json#/$defs/TemplateProvenance");

export const validateKeyOwner: Validator<KeyOwner> = registry.validator(
  "config.json#/$defs/KeyOwner",
);

export const validateActor: Validator<Actor> = registry.validator(
  "context.json#/$defs/Actor",
);

export const validateDeviceScope: Validator<DeviceScope> = registry.validator(
  "context.json#/$defs/DeviceScope",
);

export const validateProjectIdentity: Validator<ProjectIdentity> =
  registry.validator("context.json#/$defs/ProjectIdentity");

export const validateSession: Validator<Session> = registry.validator(
  "context.json#/$defs/Session",
);

export const validateAmbientContext: Validator<AmbientContext> =
  registry.validator("context.json#/$defs/AmbientContext");

export const validateStatelessContext: Validator<StatelessContext> =
  registry.validator("context.json#/$defs/StatelessContext");

export const validateDeviceContext: Validator<DeviceContext> =
  registry.validator("context.json#/$defs/DeviceContext");

export const validateProjectContext: Validator<ProjectContext> =
  registry.validator("context.json#/$defs/ProjectContext");

export const validateLeaseAcquireContext: Validator<LeaseAcquireContext> =
  registry.validator("context.json#/$defs/LeaseAcquireContext");

export const validateLeaseHeldContext: Validator<LeaseHeldContext> =
  registry.validator("context.json#/$defs/LeaseHeldContext");

export const validateBoundContext: Validator<BoundContext> = registry.validator(
  "context.json#/$defs/BoundContext",
);

export const validateDetectionObservation: Validator<DetectionObservation> =
  registry.validator("detection.json");

export const validateDetectionOrigin: Validator<DetectionOrigin> =
  registry.validator("detection.json#/$defs/DetectionOrigin");

export const validateDocsRecords: Validator<DocsRecords> =
  registry.validator("docs.json");

export const validateOperationDocs: Validator<OperationDocs> =
  registry.validator("docs.json#/$defs/OperationDocs");

export const validateExample: Validator<Example> = registry.validator(
  "docs.json#/$defs/Example",
);

export const validateForgeError: Validator<ForgeError> =
  registry.validator("error.json");

export const validateCoreErrorCode: Validator<CoreErrorCode> =
  registry.validator("error.json#/$defs/CoreErrorCode");

export const validateRetryPosture: Validator<RetryPosture> = registry.validator(
  "error.json#/$defs/RetryPosture",
);

export const validateContextField: Validator<ContextField> = registry.validator(
  "error.json#/$defs/ContextField",
);

export const validateLeaseConflict: Validator<LeaseConflict> =
  registry.validator("error.json#/$defs/LeaseConflict");

export const validateEvidence: Validator<Evidence> =
  registry.validator("evidence.json");

export const validateEvidenceStatus: Validator<EvidenceStatus> =
  registry.validator("evidence.json#/$defs/EvidenceStatus");

export const validateCheckItem: Validator<CheckItem> = registry.validator(
  "evidence.json#/$defs/CheckItem",
);

export const validateInterfaceDocument: Validator<InterfaceDocument> =
  registry.validator("interface.json");

export const validateSchemaRef: Validator<SchemaRef> = registry.validator(
  "interface.json#/$defs/SchemaRef",
);

export const validateInterfaceOperation: Validator<InterfaceOperation> =
  registry.validator("interface.json#/$defs/InterfaceOperation");

export const validateInvocationRequest: Validator<InvocationRequest> =
  registry.validator("invocation.json");

export const validateExecutionObservation: Validator<ExecutionObservation> =
  registry.validator("observation.json");

export const validateExecutionStatus: Validator<ExecutionStatus> =
  registry.validator("observation.json#/$defs/ExecutionStatus");

export const validateLimitHit: Validator<LimitHit> = registry.validator(
  "observation.json#/$defs/LimitHit",
);

export const validateEffectOutcome: Validator<EffectOutcome> =
  registry.validator("observation.json#/$defs/EffectOutcome");

export const validateEffectObservation: Validator<EffectObservation> =
  registry.validator("observation.json#/$defs/EffectObservation");

export const validateOperationDeclaration: Validator<OperationDeclaration> =
  registry.validator("operation.json");

export const validateDeprecation: Validator<Deprecation> = registry.validator(
  "operation.json#/$defs/Deprecation",
);

export const validateMcpToolAnnotations: Validator<McpToolAnnotations> =
  registry.validator("projection.json#/$defs/McpToolAnnotations");

export const validateMcpTool: Validator<McpTool> = registry.validator(
  "projection.json#/$defs/McpTool",
);

export const validateResultEnvelope: Validator<ResultEnvelope> =
  registry.validator("result.json");

export const validateSuccessEnvelope: Validator<SuccessEnvelope> =
  registry.validator("result.json#/$defs/SuccessEnvelope");

export const validateFailureEnvelope: Validator<FailureEnvelope> =
  registry.validator("result.json#/$defs/FailureEnvelope");

export const validateWarning: Validator<Warning> = registry.validator(
  "result.json#/$defs/Warning",
);

export const validateStateRecord: Validator<StateRecord> = registry.validator(
  "state.json#/$defs/StateRecord",
);

export const validateStateEvent: Validator<StateEvent> = registry.validator(
  "state.json#/$defs/StateEvent",
);

export const validateLeaseHolder: Validator<LeaseHolder> = registry.validator(
  "state.json#/$defs/LeaseHolder",
);

export const validateLeaseRecord: Validator<LeaseRecord> = registry.validator(
  "state.json#/$defs/LeaseRecord",
);

export const validateTemplateDocument: Validator<TemplateDocument> =
  registry.validator("template.json");

export const validateItemId: Validator<ItemId> = registry.validator(
  "tracker.json#/$defs/ItemId",
);

export const validateItemStatus: Validator<ItemStatus> = registry.validator(
  "tracker.json#/$defs/ItemStatus",
);

export const validateTrackerItem: Validator<TrackerItem> = registry.validator(
  "tracker.json#/$defs/TrackerItem",
);

export const validateCreateItemInput: Validator<CreateItemInput> =
  registry.validator("tracker.json#/$defs/CreateItemInput");

export const validateItemRef: Validator<ItemRef> = registry.validator(
  "tracker.json#/$defs/ItemRef",
);

export const validateListItemsInput: Validator<ListItemsInput> =
  registry.validator("tracker.json#/$defs/ListItemsInput");

export const validateListItemsOutput: Validator<ListItemsOutput> =
  registry.validator("tracker.json#/$defs/ListItemsOutput");

export const validateUpdateItemInput: Validator<UpdateItemInput> =
  registry.validator("tracker.json#/$defs/UpdateItemInput");

export const validateCommentInput: Validator<CommentInput> = registry.validator(
  "tracker.json#/$defs/CommentInput",
);

export const validateCommentOutput: Validator<CommentOutput> =
  registry.validator("tracker.json#/$defs/CommentOutput");

export const validateClaimInput: Validator<ClaimInput> = registry.validator(
  "tracker.json#/$defs/ClaimInput",
);

export const validateLeaseGrant: Validator<LeaseGrant> = registry.validator(
  "tracker.json#/$defs/LeaseGrant",
);

export const validateCloseInput: Validator<CloseInput> = registry.validator(
  "tracker.json#/$defs/CloseInput",
);
