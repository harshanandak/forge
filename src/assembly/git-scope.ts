import { nodeConfigFiles, resolveIn } from "../adapters/fs/index.ts";
import { relative, sep, isAbsolute } from "node:path";
import { cloudBinding } from "./cloud-binding.ts";
import { LocalState } from "./state.ts";
import {
  boundLaneKey,
  readBoundLane,
} from "../blocks/work/bound-lane-state.ts";
import { projectManifestRoot, type GitScope } from "./providers.ts";

import { reopenGitScope } from "./saved-git-scope.ts";

/** Only a matching private attachment may recover ancestry before the first Git discovery. */
export async function deviceGitScope(
  root: string,
  deviceRoot: string,
  home?: string,
  explicit?: GitScope,
): Promise<GitScope | null> {
  const device = LocalState.deviceRecords(deviceRoot);
  try {
    const binding = cloudBinding(root, home);
    if (binding.kind !== "bound") return reopenGitScope(root, explicit);
    if (!nodeConfigFiles(deviceRoot).list(".").includes("records.sqlite"))
      return reopenGitScope(root, explicit);
    const owner = await device.open(false);
    const target = resolveIn(projectManifestRoot(root), ".", "follow");
    const prefix = boundLaneKey(binding);
    let saved: GitScope | undefined;
    for (const row of owner?.list("forge/work", prefix) ?? []) {
      const record = readBoundLane(row.value, row.key.slice(prefix.length));
      const lane = record.lane;
      const from = lane.gitScope && relative(lane.gitScope.lane.lexical, root);
      const lexical =
        from !== undefined &&
        !isAbsolute(from) &&
        from !== ".." &&
        !from.startsWith(".." + sep);
      if (!lexical && relative(lane.worktree, target) !== "") continue;
      const scope = reopenGitScope(root, record.lane.gitScope ?? null);
      if (saved && JSON.stringify(scope) !== JSON.stringify(saved)) return null;
      saved = scope;
    }
    return saved ?? reopenGitScope(root, explicit);
  } catch {
    // Diagnostics and release remain available; Git consumers refuse this explicit missing scope.
    return null;
  } finally {
    await device.close();
  }
}
