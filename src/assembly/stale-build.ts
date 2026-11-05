import { nodeConfigFiles } from "../adapters/fs/index.ts";
import { localUpgradeCommand } from "../adapters/node-runtime/catalog.ts";
import type { UpgradeHint } from "../generated/types.ts";
import { GENERATED_MARKER } from "../surface/skills.ts";
import { buildIdentity, packageRoot } from "../version.ts";

export function upgradeHint(required: string): UpgradeHint {
  return {
    running: buildIdentity,
    required,
    command: localUpgradeCommand(packageRoot),
  };
}

/** Only generated operation headings are evidence; arbitrary prose is not a contract. */
export function missingOperationHint(
  root: string,
  op: string,
): UpgradeHint | undefined {
  const files = nodeConfigFiles(root);
  for (const directory of [".agents/skills", ".claude/skills"]) {
    try {
      for (const name of files.list(directory).slice(0, 100)) {
        const path = `${directory}/${name}/SKILL.md`;
        try {
          const bytes = files.read(path, 65_536);
          if (!bytes) continue;
          const text = new TextDecoder().decode(bytes);
          if (
            text.split(/\r?\n/).includes(GENERATED_MARKER) &&
            text
              .split(/\r?\n/)
              .some(
                (line) =>
                  line === `## \`${op}\`` || line.startsWith(`## \`${op}\` `),
              )
          )
            return upgradeHint(
              `${op}, declared by ${path}; this build does not provide it`,
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
