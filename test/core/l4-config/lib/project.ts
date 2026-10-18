import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { yamlConfigCodec } from "../../../../src/adapters/config-yaml/index.ts";
import type {
  BlockSource,
  TemplateDocument,
} from "../../../../src/contract/index.ts";
import {
  type ConfigFiles,
  createConfig,
  createTemplates,
  nodeConfigFiles,
  type TemplateEnvironment,
} from "../../../../src/core/config/index.ts";

const ROOT = new URL("../../../../", import.meta.url);

export function readJsonAt(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8"));
}

export const npmDetections = (): unknown[] =>
  readJsonAt(
    "test/node-fixtures/config/npm-project.detections.json",
  ) as unknown[];

export const delivery = (): TemplateDocument =>
  readJsonAt(
    "test/contract/fixtures/templates/forge-delivery.json",
  ) as TemplateDocument;
export const starter = (): TemplateDocument =>
  readJsonAt(
    "test/contract/fixtures/templates/forge-starter.json",
  ) as TemplateDocument;

const BUILTINS = new Set([
  "work",
  "memory",
  "context",
  "check",
  "git",
  "pr",
  "github",
  "policy",
  "workflow",
  "skills",
]);

export interface Fixture {
  readonly root: string;
  readonly env: TemplateEnvironment;
  readonly config: ReturnType<typeof createConfig>;
  readonly templates: ReturnType<typeof createTemplates>;
  readonly installed: Map<string, TemplateDocument>;
  read(path?: string): string | undefined;
  readonly clock: { now(): number; advance(ms: number): void };
  cleanup(): void;
}

export interface FixtureOptions {
  readonly detections?: () => readonly unknown[];
  readonly files?: (real: ConfigFiles) => ConfigFiles;
  readonly root?: string;
  readonly configSchema?: TemplateEnvironment["configSchema"];
}

export function makeProject(options: FixtureOptions = {}): Fixture {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "forge-l4-config-"));
  let time = Date.UTC(2026, 9, 18, 9, 0, 0);
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
  const installed = new Map<string, TemplateDocument>([
    ["forge/delivery", delivery()],
    ["forge/starter", starter()],
  ]);
  const real = nodeConfigFiles(root);
  const env: TemplateEnvironment = {
    files: options.files === undefined ? real : options.files(real),
    codec: yamlConfigCodec,
    clock,
    detect: options.detections ?? (() => []),
    templates: {
      list: () => [...installed.values()],
      get: (id) => installed.get(id),
    },
    builtinSource: (name): BlockSource | undefined =>
      BUILTINS.has(name) ? { builtin: `forge/${name}` } : undefined,
    ...(options.configSchema === undefined
      ? {}
      : { configSchema: options.configSchema }),
  };
  return {
    root,
    env,
    config: createConfig(env),
    templates: createTemplates(env),
    installed,
    clock,
    read(path = ".forge/config.yaml") {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return undefined;
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The ForgeError a call throws, or undefined if it does not throw. */
export function failureOf(
  call: () => unknown,
): { code: string; message: string; pointer?: string } | undefined {
  try {
    call();
  } catch (error) {
    if (typeof error === "object" && error !== null && "error" in error) {
      return (
        error as { error: { code: string; message: string; pointer?: string } }
      ).error;
    }
    throw error;
  }
  return undefined;
}
