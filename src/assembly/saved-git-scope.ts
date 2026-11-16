import { relative, isAbsolute, sep } from "node:path";
import { ForgeFailure } from "../contract/failure.ts";
import {
  createGitScope,
  fullyAbsolute,
  projectManifestRoot,
  type GitScope,
} from "./providers.ts";
const refuse = (code: string, message: string): never => {
  throw new ForgeFailure({ code, message, retry: "reconcile_first" });
};
function within(base: string, target: string): boolean {
  const from = relative(base, target);
  return from !== ".." && !from.startsWith(".." + sep) && !isAbsolute(from);
}
export function validGitScope(value: unknown): value is GitScope {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "lane,project"
  )
    return false;
  return ["project", "lane"].every((key) => {
    const pair = Reflect.get(value, key) as GitScope["project"] | undefined;
    return (
      !!pair &&
      Object.keys(pair).sort().join() === "lexical,real" &&
      [pair.lexical, pair.real].every(
        (path) => typeof path === "string" && fullyAbsolute(path),
      )
    );
  });
}
/** Persisted ancestry is authority; filesystem discovery cannot replace missing provenance. */
export function reopenGitScope(
  root: string,
  saved?: GitScope | null,
): GitScope {
  if (saved !== undefined) {
    try {
      if (
        saved &&
        validGitScope(saved) &&
        [saved.project, saved.lane].every(
          (pair) =>
            relative(createGitScope(pair.lexical).project.real, pair.real) ===
            "",
        ) &&
        within(saved.lane.real, createGitScope(root).lane.real)
      )
        return saved;
    } catch {
      /* Missing roots and changed aliases have the same refusal. */
    }
    refuse(
      "INPUT_CONFLICT",
      saved === null
        ? "This lane's state predates saved scopes. Nobody can restart this issue's lane or reuse this checkout while that state remains, even after release or with explicit roots. No supported reset exists yet (forge-1447). Start the work under a new issue in a different prepared checkout."
        : "Saved Git roots are missing, changed or unavailable; reattach before using Git.",
    );
  }
  const project = projectManifestRoot(root);
  return createGitScope(project, root);
}
