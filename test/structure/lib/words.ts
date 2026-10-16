import type { SourceFile, Violation } from "./repo.ts";

/** Split text into lower-case words: `issueId`, `ISSUE_ID` and `issue-id` all give `issue`, `id`. */
export function wordsOf(text: string): string[] {
  const words: string[] = [];
  for (const run of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const parts = run
      .replace(/([A-Z]{2,})s(?![a-z])/g, "$1S")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(" ");
    for (const part of parts) words.push(part.toLowerCase());
  }
  return words;
}

/**
 * Find `terms` (single words) and `phrases` (adjacent word pairs) in each line of each file.
 * Matching is on whole words, so `staged` and `prefix` never match `stage` and `pr`.
 */
export function findWords(
  files: readonly SourceFile[],
  terms: ReadonlySet<string>,
  phrases: ReadonlyMap<string, string>,
  rule: string,
  explain: (term: string) => string,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const words = wordsOf(line);
      const seen = new Set<string>();
      for (const [at, word] of words.entries()) {
        if (terms.has(word)) seen.add(word);
        const next = words[at + 1];
        const phrase =
          next === undefined ? undefined : phrases.get(`${word} ${next}`);
        if (phrase !== undefined) seen.add(phrase);
      }
      for (const term of seen) {
        violations.push({
          rule,
          file: file.path,
          line: index + 1,
          message: explain(term),
        });
      }
    }
  }
  return violations;
}
