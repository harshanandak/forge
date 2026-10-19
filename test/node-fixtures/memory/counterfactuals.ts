/** One fix removed from the installed copy; the named journey must then fail with this evidence. */
export interface Counterfactual {
  /** Under dist/src of the installed package. */
  readonly file: string;
  readonly from: string;
  readonly to: string;
  /** Replace every occurrence rather than the first. */
  readonly all?: true;
  readonly journey: "device" | "fence";
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
];
