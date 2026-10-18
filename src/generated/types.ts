// Generated from schemas/ by tools/gen/types.ts. Do not edit; regenerate instead.

/** forge.block/1: a block's manifest. Checking it never imports the block's code. */
export interface BlockManifest {
  readonly schemaVersion: "forge.block/1";
  readonly id: BlockId;
  readonly version: SemVer;
  readonly forgeVersion?: VersionRange;
  readonly authorAbi: "forge.author/v1";
  readonly profile: ExecutionProfile;
  readonly entry: RelativePath;
  /** The exact files captured and digested at add time. */
  readonly files?: readonly RelativePath[];
  /** Outside sync blocks ship one self-contained file; runtime dependencies are not allowed in this profile. */
  readonly runtimeDependencies?: readonly unknown[];
  /** JSON Schema for this block's per-instance config. */
  readonly configSchema?: RelativePath;
  /** Each noun the block owns, with the interface version its permission keys use. */
  readonly nouns?: Readonly<Record<string, NounDeclaration>>;
  readonly operations: Readonly<Record<string, OperationDeclaration>>;
  readonly provides?: readonly ProvidedInterface[];
  readonly requires?: readonly RequiredSlot[];
  readonly docs: RelativePath;
  readonly license?: string;
  readonly repository?: string;
  readonly support?: string;
}

/** trusted-action-sync/v1: a sync handler gets {input, config, services} and returns one JSON value; a Promise is refused. */
export type ExecutionProfile = "trusted-action-sync/v1";

export interface NounDeclaration {
  readonly interface: SemVer;
}

/** An interface this block implements at an exact version, optionally under one of its nouns. */
export interface ProvidedInterface {
  readonly interface: InterfaceVersionRef;
  readonly noun?: Noun;
}

/** A typed slot the block calls through services.<slot>; config binds it to a compatible provider. */
export interface RequiredSlot {
  readonly slot: PropertyName;
  readonly interface: InterfaceRef;
  readonly optional?: boolean;
}

/** One kebab-case name segment: lower case, digits and single hyphens, no leading or trailing hyphen. */
export type Segment = string;

/** Reverse-DNS publisher, for example io.github.alice; forge is reserved for first-party blocks. */
export type Publisher = string;

/** <publisher>/<name>, for example io.github.alice/semver. */
export type BlockId = string;

/** Operation noun: one segment of 2 to 21 characters. */
export type Noun = string;

/** Operation verb: one segment of 2 to 21 characters. */
export type Verb = string;

/** Public operation address <noun>.<verb>, for example semver.bump. */
export type OperationName = string;

/** MCP tool name <noun>_<verb>, at most 48 characters so a host prefix stays within 64. */
export type McpToolName = string;

/** Name of a block instance in config; kebab-case, defaults to the block name. */
export type InstanceName = string;

/** Config key or schema property name in lowerCamel case; maps to a kebab-case CLI flag. */
export type PropertyName = string;

/** Error code in UPPER_SNAKE case. */
export type ErrorCode = string;

/** Declared effect: <noun>:read, <noun>:write or external:<target>. */
export type EffectName = string;

/** Event type <blockId>:<noun>.<past-participle>@<major>, for example io.github.alice/semver:semver.released@1. */
export type EventType = string;

/** Grant and permission key <blockId>.<noun>@<interface version>#<verb>; a local rename never changes it. */
export type PermissionKey = string;

/** Semantic Versioning 2.0.0 version, no leading v. */
export type SemVer = string;

/** Space-separated comparators that must all hold, for example >=0.1.0 <0.2.0; a bare version means exactly that version. */
export type VersionRange = string;

/** Interface identity: at least two dotted segments, for example forge.state. */
export type InterfaceId = string;

/** A required interface and major version, for example forge.state@1. */
export type InterfaceRef = string;

/** A provided interface at an exact version, for example forge.state@1.0.0. */
export type InterfaceVersionRef = string;

/** A template at an exact version, <blockId>@<version>. */
export type TemplateRef = string;

/** Content digest, sha256:<64 lower-case hex>. */
export type Digest = string;

/** RFC 3339 date-time with an explicit offset. */
export type Timestamp = string;

/** Caller-chosen request ID; identifies a request for replay, never grants a retry. */
export type RequestId = string;

/** RFC 6901 JSON Pointer. */
export type JsonPointer = string;

/** Forward-slash path relative to the block or project root; no absolute paths, no .. segments, no backslashes. */
export type RelativePath = string;

/** Who may call an operation; agents never mint trust, so human-only operations omit agent. */
export type Caller = "agent" | "human";

export type Stability = "experimental" | "stable" | "deprecated";

/** The closed set of contexts an operation may declare; the runtime requires exactly what the declared variant needs. */
export type ContextVariant = "stateless" | "device" | "project" | "leased";

/** acquire creates a lease and supplies no generation; held needs the current lease generation. */
export type LeaseMode = "acquire" | "held";

/** Reference to a named secret; plaintext credentials are never accepted. */
export interface SecretRef {
  readonly $secret: string;
}

/** A missing tool or provider is a result, not a crash. */
export interface Unavailable {
  readonly kind: "unavailable";
  readonly reason: string;
  readonly remedy: string;
}

/** Budgets applied at the byte/text parse boundary for untrusted input. */
export interface ParseLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
}

/** Text from outside the trust boundary, fenced with its provenance; it is data, never instructions. */
export interface UntrustedContent {
  readonly kind: "untrusted";
  readonly source: string;
  readonly receivedAt?: Timestamp;
  readonly text: string;
}

/** forge.config/1: the one composition document. Block instances, their config, slot bindings, exposure and template provenance. Each block's own config is validated by that block's configSchema, so core knows nothing about what a solution does. */
export interface ConfigDocument {
  readonly schemaVersion: "forge.config/1";
  readonly blocks: Readonly<Record<string, BlockInstance>>;
  readonly mcp?: McpExposure;
  /** Templates imported into this config, with the exact version and digest imported. */
  readonly templates?: readonly TemplateProvenance[];
  /** Per-key ownership of imported values, keyed by JSON Pointer into this document. */
  readonly owners?: Readonly<Record<string, KeyOwner>>;
}

export interface BlockInstance {
  readonly source: BlockSource;
  readonly enabled?: boolean;
  /** This instance's config; validated by the block's configSchema. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Required slot name to the instance that provides it. */
  readonly bind?: Readonly<Record<string, BindingTarget>>;
  /** Local noun renames; they change CLI and MCP names only, never permission keys or authority. */
  readonly rename?: Readonly<Record<string, Noun>>;
}

/** An instance name in this config, or core for a provider that core itself supplies. */
export type BindingTarget = string;

export type BlockSource = BuiltinSource | PathSource | PackageSource;

/** A block shipped inside the Forge package. */
export interface BuiltinSource {
  readonly builtin: BlockId;
}

export interface PathSource {
  readonly path: RelativePath;
}

/** An installed package; Forge never installs it. */
export interface PackageSource {
  readonly package: string;
  readonly version?: SemVer;
}

export interface McpExposure {
  /** Nouns or operations to expose as MCP tools; omitted means the default selection. */
  readonly expose?: readonly ExposureSelector[];
  readonly readOnly?: boolean;
  /** Most operation tools listed before the catalog tools take over; default 40. */
  readonly budget?: number;
  readonly toolPrefix?: Segment;
}

/** A noun, or one <noun>.<verb> operation. */
export type ExposureSelector = string;

export interface TemplateProvenance {
  readonly template: TemplateRef;
  readonly digest: Digest;
  readonly importedAt?: Timestamp;
}

/** Who wrote a key and the digest of the value they wrote; a template removes only keys it still owns unchanged. */
export interface KeyOwner {
  readonly from: TemplateRef;
  readonly baseline: Digest;
}

/** The acting identity; each agent has its own. */
export interface Actor {
  readonly kind: Caller;
  readonly id: string;
}

/** The device-level store this machine's user owns. */
export interface DeviceScope {
  readonly id: string;
}

export interface ProjectIdentity {
  readonly id: string;
  readonly root?: string;
}

export interface Session {
  readonly id: string;
}

/** Everything a caller may supply. Only what the operation's declared variant needs is bound; the rest is ignored, and nothing is invented. */
export interface AmbientContext {
  readonly actor?: Actor;
  readonly device?: DeviceScope;
  readonly project?: ProjectIdentity;
  readonly session?: Session;
  readonly leaseGeneration?: number;
  readonly subjectVersion?: string;
}

export interface StatelessContext {
  readonly variant: "stateless";
}

export interface DeviceContext {
  readonly variant: "device";
  readonly actor: Actor;
  readonly device: DeviceScope;
}

/** Project writes carry a compare-and-set revision in the state call itself, not in the context. */
export interface ProjectContext {
  readonly variant: "project";
  readonly actor: Actor;
  readonly project: ProjectIdentity;
}

/** An acquire call supplies no generation; the state owner returns the new one. */
export interface LeaseAcquireContext {
  readonly variant: "leased";
  readonly leaseMode: "acquire";
  readonly actor: Actor;
  readonly session: Session;
  readonly project: ProjectIdentity;
}

/** A held call names the lease generation it holds; subjectVersion is the exact external version when the operation declares it. */
export interface LeaseHeldContext {
  readonly variant: "leased";
  readonly leaseMode: "held";
  readonly actor: Actor;
  readonly session: Session;
  readonly project: ProjectIdentity;
  readonly leaseGeneration: number;
  readonly subjectVersion?: string;
}

/** Exactly the context an operation's declared variant requires, and nothing more. */
export type BoundContext =
  | StatelessContext
  | DeviceContext
  | ProjectContext
  | LeaseAcquireContext
  | LeaseHeldContext;

/** One value a detector read from the project, traced to its source. Detection never enables anything by itself. */
export interface DetectionObservation {
  /** Where the value lands in the derived config, as a JSON Pointer. */
  readonly key: JsonPointer;
  readonly value: unknown;
  readonly origin: DetectionOrigin;
  readonly observedAt?: Timestamp;
}

export interface DetectionOrigin {
  readonly detector: OperationName;
  readonly file?: RelativePath;
  readonly pointer?: JsonPointer;
  readonly note?: string;
}

/** forge.docs/1: one file feeding help, catalog describe, MCP titles and descriptions, and generated docs. */
export interface DocsRecords {
  readonly schemaVersion?: "forge.docs/1";
  readonly operations: Readonly<Record<string, OperationDocs>>;
  /** Field help keyed by <schema file>#<JSON Pointer>. */
  readonly fields?: Readonly<Record<string, string>>;
}

export interface OperationDocs {
  readonly title: string;
  readonly summary: string;
  readonly description?: string;
  readonly examples?: readonly Example[];
}

export interface Example {
  readonly input: unknown;
  readonly output?: unknown;
}

/** An actionable error: what was expected, what was observed, how to repair it, and whether a retry is ever safe. */
export interface ForgeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retry: RetryPosture;
  readonly pointer?: JsonPointer;
  readonly flag?: string;
  readonly expected?: unknown;
  readonly observed?: unknown;
  readonly repair?: string;
  readonly suggest?: readonly string[];
  /** Context fields the declared variant needs and the request did not supply. */
  readonly missing?: readonly ContextField[];
  readonly lease?: LeaseConflict;
  readonly currentRevision?: number;
  readonly reconcileWith?: OperationName;
}

/** Error codes core itself returns; blocks add their own UPPER_SNAKE codes. */
export type CoreErrorCode =
  | "INPUT_INVALID"
  | "INPUT_CONFLICT"
  | "OUTPUT_INVALID"
  | "UNKNOWN_COMMAND"
  | "CONTEXT_MISSING"
  | "REVISION_CONFLICT"
  | "LEASE_HELD"
  | "LEASE_STALE"
  | "LEASE_NOT_HELD"
  | "LEASE_EXPIRED"
  | "ADMISSION_REQUIRED"
  | "GRANT_REQUIRED"
  | "NOUN_COLLISION"
  | "NAME_RESERVED"
  | "PROVIDER_MISSING"
  | "BINDING_AMBIGUOUS"
  | "INTERFACE_INCOMPATIBLE"
  | "BLOCK_EXECUTION_FAILED"
  | "BLOCK_ASYNC_UNSUPPORTED"
  | "EFFECT_UNCERTAIN"
  | "LIMIT_EXCEEDED"
  | "UNAVAILABLE"
  | "INTERNAL";

/** never: do not repeat the request; reconcile_first: read the current state through reconcileWith or the named data, then decide; safe: the request had no effect and may be repeated. */
export type RetryPosture = "never" | "reconcile_first" | "safe";

export type ContextField =
  | "actor"
  | "device"
  | "project"
  | "session"
  | "leaseGeneration"
  | "subjectVersion";

/** What a caller needs to reconcile a lease conflict by reading, never by retrying blindly. */
export interface LeaseConflict {
  readonly subject: string;
  readonly holder?: LeaseHolder;
  readonly generation?: number;
  readonly expiresAt?: Timestamp;
}

/** An outcome judgement bound to what was checked. Nothing checked is never PASS. */
export interface Evidence {
  readonly status: EvidenceStatus;
  /** What was judged, for example an exact revision or artifact digest. */
  readonly subject: string;
  readonly checkedAt: Timestamp;
  readonly checked: readonly CheckItem[];
  readonly reason?: string;
  readonly inputsDigest?: Digest;
}

export type EvidenceStatus = "PASS" | "FAIL" | "INCOMPLETE" | "NOT_EXECUTED";

export interface CheckItem {
  readonly name: string;
  readonly status: EvidenceStatus;
  readonly detail?: string;
}

/** forge.interface/1: verbs any provider of an interface implements under its own noun. A provider at version M.n.p satisfies a requirement for major M. */
export interface InterfaceDocument {
  readonly schemaVersion: "forge.interface/1";
  readonly id: InterfaceId;
  readonly version: SemVer;
  readonly summary: string;
  readonly operations: Readonly<Record<string, InterfaceOperation>>;
}

/** A schema in this repository's schemas folder: <file>.json, optionally #/$defs/<Name>. */
export type SchemaRef = string;

export interface InterfaceOperation {
  readonly input: SchemaRef;
  readonly output: SchemaRef;
  readonly context: ContextVariant;
  readonly leaseMode?: LeaseMode;
  /** read: the provider declares no write effect for this verb; write: it declares <noun>:write. */
  readonly access: "read" | "write";
  readonly idempotent: boolean;
}

/** forge.invocation/1: one call to one operation, the same from the CLI, MCP, a host hook or the library API. */
export interface InvocationRequest {
  readonly schemaVersion: "forge.invocation/1";
  readonly requestId: RequestId;
  readonly op: OperationName;
  /** The operation's input; validated against the operation's own input schema. */
  readonly input: unknown;
  readonly caller: Caller;
  readonly context: AmbientContext;
  readonly dryRun?: boolean;
}

/** forge.observation/1: what one invocation actually did, including the outcome of every declared effect. */
export interface ExecutionObservation {
  readonly schemaVersion: "forge.observation/1";
  readonly requestId: RequestId;
  readonly op: OperationName;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp;
  readonly status: ExecutionStatus;
  readonly limit?: LimitHit;
  readonly effects: readonly EffectObservation[];
}

/** completed: the handler returned; failed: it threw or its output was refused; stopped: a limit ended it. */
export type ExecutionStatus = "completed" | "failed" | "stopped";

export interface LimitHit {
  readonly name: "time" | "outputBytes" | "memory" | "depth" | "nodes";
  readonly limit: number;
  readonly observed?: number;
}

/** applied and not_applied are known; uncertain must be reconciled through the owning block's read operation before any retry. */
export type EffectOutcome = "applied" | "not_applied" | "uncertain";

export interface EffectObservation {
  readonly effect: EffectName;
  readonly outcome: EffectOutcome;
  readonly target?: string;
  readonly reconcileWith?: OperationName;
  readonly detail?: string;
}

/** One operation, declared once in a block manifest; the CLI, MCP tools and help are generated from it. */
export interface OperationDeclaration {
  readonly input: RelativePath;
  readonly output: RelativePath;
  /** Ordered required scalar input properties that the CLI also accepts positionally. */
  readonly args?: readonly PropertyName[];
  readonly context: ContextVariant;
  readonly leaseMode?: LeaseMode;
  /** A leased operation that acts on an external subject requires the caller to state its exact version. */
  readonly requiresSubjectVersion?: boolean;
  /** Every effect the operation may have; an empty list means read-only. */
  readonly effects: readonly EffectName[];
  readonly destructive?: boolean;
  readonly idempotent: boolean;
  readonly callers: readonly Caller[];
  readonly stability: Stability;
  readonly deprecated?: Deprecation;
  /** Earlier names that resolve with a warning for one minor version, then stop. */
  readonly formerly?: readonly OperationName[];
}

export interface Deprecation {
  readonly since: SemVer;
  readonly use: OperationName;
  readonly removeIn?: SemVer;
}

/** Hints derived from declared effects. Clients treat them as untrusted; Forge's grants still decide. */
export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations: McpToolAnnotations;
}

/** The envelope every surface returns: the CLI prints it, MCP carries it in structuredContent. */
export type ResultEnvelope = SuccessEnvelope | FailureEnvelope;

export interface SuccessEnvelope {
  readonly ok: true;
  readonly op: OperationName;
  readonly status: "OK";
  readonly result: unknown;
  readonly warnings: readonly Warning[];
  readonly observation?: ExecutionObservation;
}

/** FAIL: the operation refused or failed; INCOMPLETE: something outside the caller's control (admission, a grant, a provider) is missing. */
export interface FailureEnvelope {
  readonly ok: false;
  readonly op?: OperationName;
  readonly status: "FAIL" | "INCOMPLETE";
  readonly error: ForgeError;
  readonly warnings: readonly Warning[];
  readonly observation?: ExecutionObservation;
}

export interface Warning {
  readonly code: ErrorCode;
  readonly message: string;
}

export interface StateRecord {
  readonly namespace: BlockId;
  readonly key: string;
  /** Starts at 1 and increases by one on every accepted write. */
  readonly revision: number;
  readonly value: unknown;
  readonly updatedAt: Timestamp;
  readonly updatedBy: Actor;
}

export interface StateEvent {
  readonly type: EventType;
  readonly namespace: BlockId;
  readonly key: string;
  readonly revision: number;
  readonly at: Timestamp;
  readonly actor: Actor;
  readonly requestId?: RequestId;
  readonly data?: unknown;
}

export interface LeaseHolder {
  readonly actor: Actor;
  readonly session: Session;
}

/** One record per leased subject. The generation only increases and is never reused; expiry is judged on the state owner's clock inside the write's transaction. */
export interface LeaseRecord {
  readonly subject: string;
  readonly holder: LeaseHolder;
  readonly generation: number;
  readonly expiresAt: Timestamp;
  readonly releasedAt?: Timestamp;
}

/** forge.template/1: a shareable composition. Importing copies its config into the project as plain, editable config. */
export interface TemplateDocument {
  readonly schemaVersion: "forge.template/1";
  readonly id: BlockId;
  readonly version: SemVer;
  readonly summary: string;
  readonly config: ConfigDocument;
}

export type ItemId = string;

export type ItemStatus = "open" | "closed";

export interface TrackerItem {
  readonly id: ItemId;
  readonly title: string;
  readonly body?: string;
  /** A provider-defined kind; providers refuse kinds they do not know. */
  readonly kind?: Segment;
  readonly status: ItemStatus;
  readonly labels: readonly string[];
  readonly parent?: ItemId;
  readonly dependsOn: readonly ItemId[];
  readonly lease?: LeaseRecord;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly revision: number;
}

export interface CreateItemInput {
  readonly title: string;
  readonly body?: string;
  readonly kind?: Segment;
  readonly labels?: readonly string[];
  readonly parent?: ItemId;
  readonly dependsOn?: readonly ItemId[];
}

export interface ItemRef {
  readonly id: ItemId;
}

export interface ListItemsInput {
  readonly status?: ItemStatus;
  /** Only open items whose dependencies are closed and that no live lease holds. */
  readonly ready?: boolean;
  readonly limit?: number;
}

export interface ListItemsOutput {
  readonly items: readonly TrackerItem[];
}

export interface UpdateItemInput {
  readonly id: ItemId;
  readonly expectRevision: number;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly dependsOn?: readonly ItemId[];
}

export interface CommentInput {
  readonly id: ItemId;
  readonly body: string;
}

export interface CommentOutput {
  readonly id: ItemId;
  readonly commentId: string;
}

export interface ClaimInput {
  readonly id: ItemId;
  readonly ttlSeconds?: number;
}

export interface LeaseGrant {
  readonly id: ItemId;
  readonly generation: number;
  readonly expiresAt: Timestamp;
}

export interface CloseInput {
  readonly id: ItemId;
  readonly reason?: string;
}
