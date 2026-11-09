import { randomUUID } from "node:crypto";
import { entryKind, nodeConfigFiles } from "../adapters/fs/index.ts";
import { ForgeFailure } from "../contract/failure.ts";

/**
 * The committed project identity: one random id that travels with the code, so every checkout and
 * worktree of a repository names the same project. It holds nothing else; the strict schema keeps
 * credentials, paths and account links out. Only an explicit init creates it.
 */
export const PROJECT_MANIFEST: string = ".forge/project.json";
export const PROJECT_ID_PATTERN: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const NAME_RULE =
  "name must be 1 to 64 letters, digits, dots, hyphens or underscores";
const MAX_MANIFEST_BYTES = 4_096;
const FIELDS = new Set(["schema", "id", "name"]);

export interface ProjectManifest {
  readonly schema: 1;
  readonly id: string;
  readonly name?: string;
}

function invalid(why: string): ForgeFailure {
  return new ForgeFailure({
    code: "INPUT_INVALID",
    message: `${PROJECT_MANIFEST} ${why}`,
    retry: "never",
    repair: "Fix the file, or ask the owner; Forge never rewrites it.",
  });
}

/**
 * A symlink, a directory or any other entry Forge cannot read safely is one documented refusal.
 * The size-limit failure keeps its own code.
 */
function unsafe(error: unknown): ForgeFailure {
  if (error instanceof ForgeFailure) return error;
  return new ForgeFailure({
    code: "PROJECT_MANIFEST_UNSAFE",
    message: `${PROJECT_MANIFEST} is not a plain file Forge can read safely (it may be a symlink, a directory or unreadable)`,
    retry: "never",
    repair: "Replace it with the committed plain file.",
  });
}

/** A FIFO, socket or device would block or misbehave on open, so every path refuses it first. */
function refuseSpecialEntry(root: string): void {
  let kind: ReturnType<typeof entryKind>;
  try {
    kind = entryKind(root, PROJECT_MANIFEST);
  } catch (error) {
    throw unsafe(error);
  }
  if (kind === "other") throw unsafe(undefined);
}

/** The manifest at a checkout root, undefined when absent; anything malformed is refused. */
export function readProjectManifest(root: string): ProjectManifest | undefined {
  refuseSpecialEntry(root);
  let bytes: Uint8Array | undefined;
  try {
    bytes = nodeConfigFiles(root).read(PROJECT_MANIFEST, MAX_MANIFEST_BYTES);
  } catch (error) {
    throw unsafe(error);
  }
  if (bytes === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid("must be a JSON object");
  const fields = value as Record<string, unknown>;
  const extra = Object.keys(fields).find((key) => !FIELDS.has(key));
  if (extra !== undefined)
    throw invalid(
      `has unknown field "${extra}"; only schema, id and name are allowed`,
    );
  if (fields.schema !== 1) throw invalid("must have schema 1");
  if (typeof fields.id !== "string" || !PROJECT_ID_PATTERN.test(fields.id))
    throw invalid("must have an id that is a lowercase UUID v4");
  if (
    fields.name !== undefined &&
    (typeof fields.name !== "string" || !NAME.test(fields.name))
  )
    throw invalid(NAME_RULE);
  return {
    schema: 1,
    id: fields.id,
    ...(typeof fields.name === "string" ? { name: fields.name } : {}),
  };
}

/** True when a manifest file is present, readable or not. */
export function projectManifestExists(root: string): boolean {
  refuseSpecialEntry(root);
  try {
    return nodeConfigFiles(root).list(".forge").includes("project.json");
  } catch (error) {
    throw unsafe(error);
  }
}

export function manifestExists(): ForgeFailure {
  return new ForgeFailure({
    code: "PROJECT_MANIFEST_EXISTS",
    message: `${PROJECT_MANIFEST} already exists; init never overwrites it.`,
    retry: "never",
    repair:
      "Changing a project id needs the owner's approval through a fork or migrate step; init and config cannot do it.",
  });
}

/** Write a new manifest with a fresh random id, only when none exists. */
export function initProjectManifest(
  root: string,
  name?: string,
): ProjectManifest {
  if (name !== undefined && !NAME.test(name)) throw invalid(NAME_RULE);
  const manifest: ProjectManifest = {
    schema: 1,
    id: randomUUID(),
    ...(name === undefined ? {} : { name }),
  };
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  refuseSpecialEntry(root);
  let created: boolean;
  try {
    created = nodeConfigFiles(root).createExclusive(PROJECT_MANIFEST, bytes);
  } catch (error) {
    throw unsafe(error);
  }
  if (!created) throw manifestExists();
  return manifest;
}
