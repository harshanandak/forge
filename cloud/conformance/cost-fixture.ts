import type { StateOwner } from "../../src/core/state/index.ts";

export const COST_CLOCK = 1_700_000_000_000;
export function populateCost(
  owner: StateOwner,
  records: number,
  floor = false,
): void {
  const actor = { kind: "agent", id: "max-source" } as const;
  for (let n = 1; n <= records; n++)
    owner.put(
      "forge/work",
      `issue:work-${n}`,
      {
        id: `work-${n}`,
        prefix: "work",
        title: `Synthetic ${n}`,
        status: "open",
        labels: [],
        dependsOn: [],
        createdAt: new Date(COST_CLOCK).toISOString(),
      },
      actor,
      { expectRevision: 0 },
    );
  if (floor)
    owner.put(
      "forge/work",
      "allocation:issue:work-",
      { prefix: "issue:work-", number: records },
      actor,
      { expectRevision: 0 },
    );
}
