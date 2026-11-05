import { nodeConfigFiles } from "../adapters/fs/index.ts";
import { localUpgradeCommand } from "../adapters/node-runtime/catalog.ts";
import type { UpgradeHint } from "../generated/types.ts";
import { GENERATED_MARKER } from "../surface/skills.ts";
import { buildIdentity, packageRoot } from "../version.ts";
import { compareVersions, parseVersion } from "../contract/version.ts";

export function upgradeHint(required: string): UpgradeHint {
  return {
    running: buildIdentity,
    required,
    ...localUpgradeCommand(packageRoot, buildIdentity.version),
  };
}

/** A later generator version and an enabled builtin are required; headings alone are not evidence. */
export function missingOperationHint(
  root: string,
  op: string,
  builtin: string,
): UpgradeHint | undefined {
  const files = nodeConfigFiles(root);
  for (const directory of [".agents/skills", ".claude/skills"]) {
    try {
      for (const name of files.list(directory).slice(0, 100)) {
        const path = `${directory}/${name}/SKILL.md`;
        try {
          const bytes = files.read(path, 65_536);
          if (!bytes) continue;
          const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
          const recorded = /^<!-- forge version: (.+) -->$/.exec(
            lines.find((line) => line.startsWith("<!-- forge version:")) ?? "",
          )?.[1];
          const required =
            recorded === undefined ? undefined : parseVersion(recorded);
          const running = parseVersion(buildIdentity.version);
          if (
            !lines.includes(GENERATED_MARKER) ||
            !required ||
            !running ||
            compareVersions(required, running) <= 0
          )
            continue;
          const heading = lines.findIndex(
            (line) =>
              line === `## \`${op}\`` || line.startsWith(`## \`${op}\` `),
          );
          if (
            heading >= 0 &&
            lines.includes(`<!-- forge block: ${builtin} -->`)
          )
            return upgradeHint(
              `Forge ${recorded} for ${op}, declared by ${path}`,
            );
        } catch {
          // Missing, unreadable and linked skills cannot establish compatibility evidence.
        }
      }
    } catch {
      // Diagnostic evidence must never replace the original command refusal.
    }
  }
  return undefined;
}
