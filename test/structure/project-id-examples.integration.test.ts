import { expect, test } from "bun:test";
import { listRepoFiles, readRepoFiles, type SourceFile } from "./lib/repo.ts";

function hardCodedIds(files: readonly SourceFile[]): string[] {
  return files.flatMap(({ path, text }) =>
    text
      .split(/\r?\n/)
      .flatMap((line, index) =>
        /\bforge-(?:\d+\b|<[^>]+>|\{[^}]+\})/i.test(line)
          ? [`${path}:${index + 1}`]
          : [],
      ),
  );
}

test("shipped skills, rules, hooks and templates use project-neutral issue ids", () => {
  const files = readRepoFiles(
    listRepoFiles().filter(
      (path) =>
        /^(?:templates|skills|rules|hooks)\//.test(path) ||
        /^\.(?:agents|claude|codex|cursor|hermes)\//.test(path),
    ),
  );
  expect(hardCodedIds(files)).toEqual([]);
}, 30_000);

test("the issue example guard rejects concrete and placeholder Forge ids", () => {
  for (const text of [
    "show forge-123",
    "claim FORGE-2",
    "show forge-<n>",
    "show forge-{number}",
  ])
    expect(hardCodedIds([{ path: "templates/example.md", text }])).toEqual([
      "templates/example.md:1",
    ]);
  expect(
    hardCodedIds([
      {
        path: "templates/example.md",
        text: "show <project>-<n>; use forge-loop",
      },
    ]),
  ).toEqual([]);
}, 30_000);
