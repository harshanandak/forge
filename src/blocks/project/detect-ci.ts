// Detector for continuous-integration setups, read from the provider's own config files.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import { detected } from "./observation.ts";

const AREA = "ci";

interface Provider {
  readonly name: string;
  /** Files at fixed paths. */
  readonly files: readonly string[];
  /** A folder whose YAML files are each a pipeline. */
  readonly folder?: string;
}

const PROVIDERS: readonly Provider[] = [
  { name: "github-actions", files: [], folder: ".github/workflows" },
  { name: "gitlab-ci", files: [".gitlab-ci.yml", ".gitlab-ci.yaml"] },
  { name: "circleci", files: [".circleci/config.yml"] },
  {
    name: "azure-pipelines",
    files: ["azure-pipelines.yml", "azure-pipelines.yaml"],
  },
  { name: "jenkins", files: ["Jenkinsfile"] },
  { name: "travis", files: [".travis.yml"] },
  { name: "bitbucket-pipelines", files: ["bitbucket-pipelines.yml"] },
  {
    name: "buildkite",
    files: [".buildkite/pipeline.yml", ".buildkite/pipeline.yaml"],
  },
  { name: "drone", files: [".drone.yml"] },
];

export function detectCi(files: ProjectFiles): DetectionObservation[] {
  const out: DetectionObservation[] = [];
  for (const provider of PROVIDERS) {
    const found = provider.files.filter((file) => files.exists(file));
    if (provider.folder !== undefined) {
      for (const name of files.list(provider.folder)) {
        if (/\.ya?ml$/.test(name)) found.push(`${provider.folder}/${name}`);
      }
    }
    if (found.length === 0) continue;
    out.push(
      detected(
        AREA,
        [provider.name],
        { files: found },
        { file: found[0] as string },
      ),
    );
  }
  return out;
}
