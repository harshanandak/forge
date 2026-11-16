export const BOUND_LANES: ReadonlySet<string> = new Set(
  ["start", "show", "status", "next", "record", "close", "release"].map(
    (verb) => `lane.${verb}`,
  ),
);
