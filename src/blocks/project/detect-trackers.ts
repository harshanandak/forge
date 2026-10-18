// Detector for the issue tracker a project already uses, read from the files that point at it.
// A tracker found here is reported and left alone; whether a block can work with it is the
// catalog's business, so the note says plainly when none ships.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import { detected, readJson } from "./observation.ts";

const AREA = "trackers";

const NO_ADAPTER =
  "Detected only: this release ships no adapter for this tracker, so it is reported and not connected.";

/** Hosts a package.json `bugs` or `repository` URL can point at, mapped to the tracker they mean. */
const HOSTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/github\.com\/[^/]+\/[^/]+\/issues/i, "github-issues"],
  [/gitlab\.com\/[^/]+\/[^/]+\/-?\/?issues/i, "gitlab-issues"],
  [/linear\.app\//i, "linear"],
  [/atlassian\.net\/|jira\./i, "jira"],
];

function bugsUrl(manifest: Record<string, unknown>): string | undefined {
  const bugs = manifest["bugs"];
  if (typeof bugs === "string") return bugs;
  if (typeof bugs === "object" && bugs !== null) {
    const url = (bugs as Record<string, unknown>)["url"];
    if (typeof url === "string") return url;
  }
  return undefined;
}

export function detectTrackers(files: ProjectFiles): DetectionObservation[] {
  const seen = new Map<string, DetectionObservation>();
  const add = (name: string, file: string, pointerInFile?: string): void => {
    if (seen.has(name)) return;
    seen.set(
      name,
      detected(
        AREA,
        [name],
        { adapter: false },
        {
          file,
          ...(pointerInFile === undefined ? {} : { pointer: pointerInFile }),
          note: NO_ADAPTER,
        },
      ),
    );
  };

  if (files.isDirectory(".github/ISSUE_TEMPLATE")) {
    add("github-issues", ".github/ISSUE_TEMPLATE");
  } else if (files.exists(".github/ISSUE_TEMPLATE.md")) {
    add("github-issues", ".github/ISSUE_TEMPLATE.md");
  }
  if (files.isDirectory(".gitlab/issue_templates")) {
    add("gitlab-issues", ".gitlab/issue_templates");
  }
  if (files.isDirectory(".linear") || files.exists("linear.toml")) {
    add("linear", files.isDirectory(".linear") ? ".linear" : "linear.toml");
  }
  if (files.isDirectory(".jira") || files.exists(".jira.d/config.yml")) {
    add("jira", files.isDirectory(".jira") ? ".jira" : ".jira.d/config.yml");
  }

  const manifest = readJson(files, "package.json");
  if (manifest !== null && manifest !== undefined) {
    const url = bugsUrl(manifest);
    if (url !== undefined) {
      const host = HOSTS.find(([pattern]) => pattern.test(url));
      if (host !== undefined) {
        add(
          host[1],
          "package.json",
          typeof manifest["bugs"] === "string" ? "/bugs" : "/bugs/url",
        );
      }
    }
  }
  return [...seen.values()];
}
