import { posix } from "node:path";
import { importsOf } from "./imports.ts";
import { maskSource } from "./platform.ts";
import type { SourceFile, Violation } from "./repo.ts";

// Predicate-only imports expose no minting capability.
const predicateOnly =
  /^[ \t]*(?:import|export)\s*\{\s*isVerifiedIdentity(?:\s+as\s+\w+)?\s*\}\s*from\s*["'][^"']+["']\s*;?/gm;

function mintTarget(path: string, specifier: string): boolean {
  return /^src\/ports\/identity-mint\.(?:ts|js)$/.test(
    posix.normalize(
      posix.join(posix.dirname(path), specifier.replaceAll("\\", "/")),
    ),
  );
}

function reexportsMint(file: SourceFile): boolean {
  const source = maskSource(file.text, false);
  const bindings = new Set<string>();
  // The shared scanner resolves dependencies; declarations retain local aliases.
  for (const match of source.matchAll(
    /\bimport\s+([^;]*?)\s+from\s*["'][^"']+["']/g,
  )) {
    if (
      !importsOf({ ...file, text: match[0] }).some((s) =>
        mintTarget(file.path, s),
      )
    )
      continue;
    const clause = match[1]!;
    const namespace = /\*\s+as\s+([$\w]+)/.exec(clause);
    if (namespace) bindings.add(namespace[1]!);
    for (const name of clause.matchAll(/\bmintIdentity(?:\s+as\s+([$\w]+))?/g))
      bindings.add(name[1] ?? "mintIdentity");
  }

  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+(\{[^}]*\}|[$\w]+)\s*=\s*(?:await\s+)?(?:import|require)\s*\([^;]*\)/g,
  )) {
    if (
      !importsOf({ ...file, text: match[0] }).some((s) =>
        mintTarget(file.path, s),
      )
    )
      continue;
    const clause = match[1]!;
    if (!clause.startsWith("{")) bindings.add(clause);
    else
      for (const name of clause.matchAll(/\bmintIdentity(?:\s*:\s*([$\w]+))?/g))
        bindings.add(name[1] ?? "mintIdentity");
  }
  const aliases = [
    ...maskSource(source, true).matchAll(
      /\b(?:const|let|var)\s+([$\w]+)\s*=\s*([$\w]+)\b/g,
    ),
  ];
  let size;
  do {
    size = bindings.size;
    for (const alias of aliases)
      if (bindings.has(alias[2]!)) bindings.add(alias[1]!);
  } while (bindings.size !== size);
  for (const match of source.matchAll(
    /\bexport\s+(?:\*(?:\s+as\s+\w+)?\s+from\s*["'][^"']+["']|\{[^}]*\}(?:\s+from\s*["'][^"']+["'])?|default\b[^;]*|(?:const|let|var)\b[^;]*)/g,
  )) {
    if (
      importsOf({ ...file, text: match[0] }).some((s) =>
        mintTarget(file.path, s),
      )
    )
      return true;
    const code = maskSource(match[0], true);
    if (
      (code.match(/[$A-Z_a-z][$\w]*/g) ?? []).some((name) => bindings.has(name))
    )
      return true;
  }
  return false;
}

export function findIdentityMintViolations(
  files: readonly SourceFile[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = posix.normalize(file.path.replaceAll("\\", "/"));
    const source = { path, text: file.text.replace(predicateOnly, "") };
    const verifier =
      path.startsWith("src/adapters/oidc/") ||
      path === "test/contract/lib/identity-verifier.ts";
    if (
      verifier
        ? reexportsMint(source)
        : importsOf(source).some((specifier) => mintTarget(path, specifier))
    )
      violations.push({
        rule: "identity-provenance",
        file: file.path,
        message:
          "identity-mint may be imported only by verifiers and never re-exported",
      });
  }
  return violations;
}
