/** One fix removed from the installed copy; the named journey must then fail with this evidence. */
export interface Counterfactual {
  /** Under dist/src of the installed package. */
  readonly file: string;
  readonly from: string;
  readonly to: string;
  /** Replace every occurrence rather than the first. */
  readonly all?: true;
  readonly journey: "device" | "fence" | "handoff";
  readonly evidence: string;
}

export const counterfactuals: readonly Counterfactual[] = [
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
    file: "blocks/context/index.cjs",
    from: '(thread) => thread.state === "unresolved"',
    to: '(thread) => thread.state === "resolved"',
    journey: "handoff",
    evidence: "pending review state round-trips",
  },
  {
    file: "blocks/context/index.cjs",
    from: "uncommitted: { ...value.uncommitted },",
    to: 'uncommitted: { state: "clean", base: value.head },',
    journey: "handoff",
    evidence: "uncommitted-work identity round-trips",
  },
  {
    file: "blocks/context/index.cjs",
    from: 'return digest === recorded.digest ? "same" : "changed";',
    to: 'return "same";',
    journey: "handoff",
    evidence: "different unfinished work is not mistaken",
  },
];
