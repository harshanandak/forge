import type { Operations } from "../../contract/author.ts";
import { ForgeFailure } from "../../contract/author.ts";
import type { DetectionObservation } from "../../generated/types.ts";
import { type DetectionReport, detectProject } from "./detect.ts";
import type { ProjectFiles } from "./files.ts";

/** What the runtime hands the block: a read-only view of the project folder. */
export interface ProjectServices {
  readonly files: ProjectFiles;
}

export interface DetectInput {
  readonly [key: string]: never;
}

export interface DetectOutput {
  readonly observations: readonly DetectionObservation[];
  readonly failures: DetectionReport["failures"];
}

type ProjectOperations = Operations<{
  "project.detect": readonly [DetectInput, DetectOutput];
}>;

function hasFiles(services: unknown): services is ProjectServices {
  if (typeof services !== "object" || services === null) return false;
  const files = (services as { files?: unknown }).files;
  return (
    typeof files === "object" &&
    files !== null &&
    typeof (files as { read?: unknown }).read === "function"
  );
}

export const operations: ProjectOperations = {
  "project.detect": ({ services }) => {
    if (!hasFiles(services)) {
      throw new ForgeFailure({
        code: "SERVICE_MISSING",
        message:
          "project.detect needs a read-only view of the project folder and was given none.",
        retry: "never",
        repair: "Run it through the runtime, which binds the project folder.",
      });
    }
    const { observations, failures } = detectProject(services.files);
    return { observations, failures };
  },
};
