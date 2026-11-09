import { posix } from "node:path";
import { importsOf } from "./imports.ts";
import type { SourceFile, Violation } from "./repo.ts";

// Predicate-only imports expose no minting capability.
const predicateOnly =
  /^[ \t]*(?:import|export)\s*\{\s*isVerifiedIdentity(?:\s+as\s+\w+)?\s*\}\s*from\s*["'][^"']+["']\s*;?/gm;

export function findIdentityMintViolations(
  files: readonly SourceFile[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = posix.normalize(file.path.replaceAll("\\", "/"));
    if (
      !/^(?:src|bin|cloud\/src|team)\//.test(path) ||
      path.startsWith("src/adapters/oidc/")
    )
      continue;
    const text = file.text.replace(predicateOnly, "");
    for (const specifier of importsOf({ path, text })) {
      const target = posix.normalize(
        posix.join(posix.dirname(path), specifier.replaceAll("\\", "/")),
      );
      if (!/^src\/ports\/identity-mint\.(?:ts|js)$/.test(target)) continue;
      violations.push({
        rule: "identity-provenance",
        file: file.path,
        message: "identity-mint may be imported only by identity verifiers",
      });
    }
  }
  return violations;
}
