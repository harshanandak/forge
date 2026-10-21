// Handlers for the operations declared in operations.json. The runtime validates input and output
// against the declared schemas; each handler is synchronous and returns one JSON value.
import { createConfig, type PatchStep } from "./config.ts";
import { createTemplates, type TemplateEnvironment } from "./templates.ts";

export type ConfigOperations = Readonly<
  Record<string, (input: unknown) => unknown>
>;

type Input = Readonly<Record<string, unknown>>;

const text = (input: Input, key: string): string => String(input[key]);
const revision = (input: Input): { expectRevision?: string } =>
  typeof input.expectRevision === "string"
    ? { expectRevision: input.expectRevision }
    : {};
const steps = (input: Input, key: string): readonly PatchStep[] =>
  Array.isArray(input[key]) ? (input[key] as PatchStep[]) : [];

export function createConfigOperations(
  env: TemplateEnvironment,
): ConfigOperations {
  const config = createConfig(env);
  const templates = createTemplates(env);
  const op =
    (handle: (input: Input) => unknown) =>
    (input: unknown): unknown =>
      handle(
        typeof input === "object" && input !== null ? (input as Input) : {},
      );
  return {
    "config.show": op((i) =>
      config.show({ invocation: steps(i, "invocation") }),
    ),
    "config.explain": op((i) => config.explain({ path: text(i, "path") })),
    "config.detect": op(() => config.detect()),
    "config.preview": op((i) => config.preview({ patch: steps(i, "patch") })),
    "config.apply": op((i) =>
      config.apply({
        patch: steps(i, "patch"),
        expectRevision: text(i, "expectRevision"),
      }),
    ),
    "config.set": op((i) =>
      config.set({
        path: text(i, "path"),
        value: i.value,
        expectRevision: text(i, "expectRevision"),
      }),
    ),
    "config.save": op((i) =>
      config.save({
        expectRevision: text(i, "expectRevision"),
        ...(Array.isArray(i.paths) ? { paths: i.paths.map(String) } : {}),
      }),
    ),
    "template.list": op(() => templates.list()),
    "template.show": op((i) =>
      templates.show({ template: text(i, "template") }),
    ),
    "template.import": op((i) =>
      templates.importTemplate({
        template: text(i, "template"),
        ...revision(i),
      }),
    ),
    "template.remove": op((i) =>
      templates.remove({ template: text(i, "template"), ...revision(i) }),
    ),
  };
}
