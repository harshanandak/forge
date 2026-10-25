/** One fix removed from the installed copy; the named journey must then fail with this evidence. */
export interface Counterfactual {
  /** Under dist/src of the installed package. */
  readonly file: string;
  readonly from: string;
  readonly to: string;
  /** Replace every occurrence rather than the first. */
  readonly all?: true;
  readonly journey:
    | "device"
    | "anywhere"
    | "projectBoundary"
    | "initializeSession"
    | "fence"
    | "levels";
  readonly evidence: string;
}

export const counterfactuals: readonly Counterfactual[] = [
  {
    file: "assembly/index.js",
    from: "!call.inProject && !configured.configured",
    to: "false",
    journey: "anywhere",
    evidence: "Unknown operation: memory.search",
  },
  {
    file: "assembly/index.js",
    from: 'deviceRoot: process.env.FORGE_DEVICE_ROOT ?? join(homedir(), ".forge"),',
    to: 'deviceRoot: process.env.FORGE_DEVICE_ROOT ?? join(homedir(), ".forge"), project: existsSync(join(root, ".forge", "config.yaml")),',
    journey: "initializeSession",
    evidence: "project write after initialization",
  },
  {
    file: "assembly/index.js",
    from: "servesProject: call.inProject,",
    to: "servesProject: true,",
    journey: "anywhere",
    evidence: "a person outside a project defaults to device",
  },
  {
    file: "assembly/index.js",
    from: '!call.inProject && (target?.declaration.context === "project" || target?.declaration.context === "leased")',
    to: "false",
    journey: "projectBoundary",
    evidence: "decision propose requires a project",
  },
  {
    // Memory declared for the project would write the project's store, not the device's.
    file: "blocks/memory/forge.block.json",
    from: '"context": "device"',
    to: '"context": "project"',
    all: true,
    journey: "device",
    evidence: "memory must not open the project store",
  },
  {
    file: "blocks/memory/index.cjs",
    from: "text: neutralize(text),",
    to: "text,",
    journey: "fence",
    evidence: "imitation of a fence delimiter is defanged",
  },
  {
    // The provenance would come from the text instead of from the block.
    file: "blocks/memory/index.cjs",
    from: "source,\n text: neutralize(text),",
    to: 'source: text.includes("forge/policy") ? "forge/policy" : source,\n text: neutralize(text),',
    journey: "fence",
    evidence: "provenance names the note",
  },
  {
    // Project notes would be written to the device store, so their ids would not be their own.
    file: "blocks/memory/index.cjs",
    from: 'if (level === "device") return deviceSource(services.state);',
    to: "return deviceSource(services.state);",
    journey: "levels",
    evidence: "a project note's id names its project",
  },
  {
    // The assembly would hand the device store over as the project's.
    file: "assembly/index.js",
    from: "projectState,\n deviceState,\n namespace,",
    to: "projectState: deviceState,\n deviceState,\n namespace,",
    journey: "levels",
    evidence: "a project note's id names its project",
  },
  {
    // Another project's notes would come back as if they were the caller's own.
    file: "blocks/memory/index.cjs",
    from: "return projectSource(found.identity, found.state, true);",
    to: "return projectSource(found.identity, found.state, false);",
    journey: "levels",
    evidence: "pulled notes are read-only",
  },
  {
    // A missing level would be guessed for an agent instead of refused.
    file: "blocks/memory/index.cjs",
    from: 'const policy = config.levels?.[services.levels.caller] ?? "required";',
    to: 'const policy = "nearest";',
    journey: "levels",
    evidence: "an agent that omits the level is refused",
  },
  {
    // A retried move would not find the copy it already made.
    file: "blocks/memory/index.cjs",
    from: "const made = target.state.get(marker);",
    to: "const made = undefined;",
    journey: "levels",
    evidence: "the retried move finishes with one copy",
  },
];
