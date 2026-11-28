import { createHash } from "node:crypto";
import { yamlConfigCodec } from "../adapters/config-yaml/index.ts";
import { DEFAULT_PARSE_LIMITS } from "../contract/untrusted.ts";
import { refuse } from "../core/trust/index.ts";
import type {
  SkillManifest,
  SkillManifestFile,
  SkillResourceFile,
} from "../ports/skill-resources.ts";
import { record } from "../surface/dispatch.ts";
import { SKILL_DESCRIPTION_MAX } from "../surface/skills.ts";

function skillFrontmatter(
  file: SkillResourceFile,
): Readonly<Record<string, unknown>> {
  const text = new TextDecoder().decode(file.bytes);
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  const decoded =
    header === undefined
      ? undefined
      : yamlConfigCodec.decode(header, DEFAULT_PARSE_LIMITS);
  const frontmatter = decoded?.ok === true ? record(decoded.value) : undefined;
  const name = frontmatter?.name;
  const description = frontmatter?.description;
  if (
    frontmatter === undefined ||
    typeof name !== "string" ||
    name !== file.noun ||
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    typeof description !== "string" ||
    description.trim() === "" ||
    description.length > SKILL_DESCRIPTION_MAX
  )
    refuse("OUTPUT_INVALID", `Invalid frontmatter in ${file.path}`);
  return frontmatter;
}

export function skillManifests(
  files: ReadonlyMap<string, SkillResourceFile>,
): ReadonlyMap<string, SkillManifest> {
  const byNoun = new Map<string, SkillManifestFile[]>();
  for (const [uri, { noun, bytes }] of files) {
    const entries = byNoun.get(noun) ?? [];
    entries.push({
      uri,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength,
    });
    byNoun.set(noun, entries);
  }
  const manifests = new Map<string, SkillManifest>();
  for (const [uri, file] of files) {
    if (file.path !== `${file.noun}/SKILL.md`) continue;
    manifests.set(uri, {
      uri,
      frontmatter: skillFrontmatter(file),
      resources: byNoun.get(file.noun)!,
    });
  }
  return manifests;
}
