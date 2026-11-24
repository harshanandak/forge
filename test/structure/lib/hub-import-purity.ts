import { isTestFile, type SourceFile, type Violation } from "./repo.ts";

export function isHubSource(path: string): boolean {
  return (
    path.startsWith("hub/src/") && path.endsWith(".ts") && !isTestFile(path)
  );
}

export function findHubImportPurityViolations(
  _files: readonly SourceFile[],
): Promise<Violation[]> {
  return Promise.resolve([]);
}
