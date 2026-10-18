// The template/user merge model (templates.ts), proved by enumeration: every combination of the
// user's state, the template's change (shape changes included), another template sharing the key
// (present, at a different installed version, or uninstalled) and the operation run on it. Each
// case checks the outcome the model gives and four invariants: user values are never lost, nothing
// is overwritten silently, removal leaves only keys someone may still own, and a held conflict
// leaves everything at and below its root untouched.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { yamlConfigCodec } from "../../../src/adapters/config-yaml/index.ts";
import {
  DEFAULT_PARSE_LIMITS,
  type TemplateDocument,
} from "../../../src/contract/index.ts";
import type { ConfigFiles, KeyChange } from "../../../src/core/config/index.ts";
import { makeProject } from "./lib/project.ts";

setDefaultTimeout(60_000);

const ROOT = "/blocks/check/config/timeout";
const CHILD = `${ROOT}/seconds`;
const BASE = 300;

const USERS = {
  untouched: BASE,
  edited: 120,
  editedObject: { seconds: 30 },
  removed: undefined,
} as const;
const CHANGES = {
  unchanged: BASE,
  changed: 600,
  toObject: { seconds: 600, grace: 5 },
  dropped: undefined,
} as const;
const OTHERS = ["none", "sharing", "versionMismatch", "uninstalled"] as const;
const OPS = ["update", "acceptRoot", "acceptChild", "remove"] as const;

type User = keyof typeof USERS;
type Change = keyof typeof CHANGES;
type Other = (typeof OTHERS)[number];
type Op = (typeof OPS)[number];

function memoryFiles(): ConfigFiles {
  const files = new Map<string, Uint8Array>();
  return {
    read: (path) => files.get(path),
    write: (path, bytes) => {
      files.set(path, new Uint8Array(bytes));
    },
    remove: (path) => {
      files.delete(path);
    },
    list: (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(`${dir}/`))
        .map((k) => k.slice(dir.length + 1))
        .filter((name) => !name.includes("/"))
        .sort(),
    createExclusive: (path, bytes) => {
      if (files.has(path)) return false;
      files.set(path, new Uint8Array(bytes));
      return true;
    },
  };
}

function template(
  id: string,
  version: string,
  config: Record<string, unknown>,
): TemplateDocument {
  return {
    schemaVersion: "forge.template/1",
    id,
    version,
    summary: `${id} for tests`,
    config: {
      schemaVersion: "forge.config/1",
      blocks: { check: { source: { builtin: "forge/check" }, config } },
    },
  } as unknown as TemplateDocument;
}

const withTimeout = (value: unknown): Record<string, unknown> =>
  value === undefined ? { retries: 1 } : { timeout: value };

type Doc = {
  blocks?: { check?: { config?: Record<string, unknown> } };
  owners?: Record<string, { from: string; baseline: string }>;
};

function decode(files: ConfigFiles): Doc {
  const bytes = files.read(".forge/config.yaml");
  if (bytes === undefined) return {};
  const decoded = yamlConfigCodec.decode(
    new TextDecoder().decode(bytes),
    DEFAULT_PARSE_LIMITS,
  );
  if (!decoded.ok) throw new Error(decoded.error.message);
  return decoded.value === null ? {} : (decoded.value as Doc);
}

const valueAt = (doc: Doc): unknown => doc.blocks?.check?.config?.timeout;
const ownersUnder = (doc: Doc): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(doc.owners ?? {}).filter(
      ([p]) => p === ROOT || p.startsWith(`${ROOT}/`),
    ),
  );

interface Outcome {
  readonly before: Doc;
  readonly after: Doc;
  readonly conflicts: readonly KeyChange[];
  readonly problems: readonly string[];
}

function run(user: User, change: Change, other: Other, op: Op): Outcome {
  const files = memoryFiles();
  const p = makeProject({ files: () => files });
  try {
    const rev = (): string => p.config.show().revision;
    p.installed.set("acme/t", template("acme/t", "1.0.0", { timeout: BASE }));
    p.installed.set("acme/u", template("acme/u", "1.0.0", { timeout: BASE }));
    p.templates.importTemplate({ template: "acme/t", expectRevision: rev() });
    if (other !== "none")
      p.templates.importTemplate({ template: "acme/u", expectRevision: rev() });
    if (user === "removed")
      p.config.apply({
        patch: [{ op: "remove", path: ROOT }],
        expectRevision: rev(),
      });
    else if (user !== "untouched")
      p.config.set({ path: ROOT, value: USERS[user], expectRevision: rev() });
    p.installed.set(
      "acme/t",
      template("acme/t", "2.0.0", withTimeout(CHANGES[change])),
    );
    if (other === "versionMismatch")
      p.installed.set("acme/u", template("acme/u", "2.0.0", { retries: 2 }));
    if (other === "uninstalled") p.installed.delete("acme/u");

    const before = decode(files);
    let conflicts: readonly KeyChange[] = [];
    if (op === "remove") {
      p.templates.remove({ template: "acme/t", expectRevision: rev() });
    } else {
      const accept =
        op === "acceptRoot" ? [ROOT] : op === "acceptChild" ? [CHILD] : [];
      conflicts = p.templates.update({
        template: "acme/t",
        expectRevision: rev(),
        accept,
      }).conflicts;
    }
    return {
      before,
      after: decode(files),
      conflicts,
      problems: p.config.show().problems,
    };
  } finally {
    p.cleanup();
  }
}

/** What the model says the key holds afterwards. */
function expected(user: User, change: Change, other: Other, op: Op): unknown {
  const releasing = op === "remove" || change === "dropped";
  if (releasing)
    return user === "untouched"
      ? other === "none"
        ? undefined
        : BASE
      : USERS[user];
  if (change === "unchanged") return USERS[user];
  if (user === "untouched") return CHANGES[change];
  // only the root accepts a conflict; a child below it never applies part of it
  return op === "acceptRoot" ? CHANGES[change] : USERS[user];
}

const cases: [User, Change, Other, Op][] = [];
for (const user of Object.keys(USERS) as User[])
  for (const change of Object.keys(CHANGES) as Change[])
    for (const other of OTHERS)
      for (const op of OPS) cases.push([user, change, other, op]);

describe("the template/user merge model, every combination", () => {
  test(`enumerates ${cases.length} cases`, () => {
    expect(cases.length).toBe(4 * 4 * 4 * 4);
  });

  test.each(cases)(
    "user %s, template %s, other %s, %s",
    (user, change, other, op) => {
      const { before, after, conflicts, problems } = run(
        user,
        change,
        other,
        op,
      );
      const diverged = user !== "untouched";
      const templateChanged = change === "changed" || change === "toObject";
      const updating = op !== "remove";
      const accepted = op === "acceptRoot";
      const held = updating && diverged && templateChanged && !accepted;

      // the outcome the model gives
      expect(valueAt(after)).toEqual(expected(user, change, other, op));
      expect(problems).toEqual([]);

      // 1. user values are never lost: only an explicit accept replaces them
      if (diverged && !(updating && templateChanged && accepted))
        expect(valueAt(after)).toEqual(USERS[user]);

      // 2. no silent overwrite: a changed value was the template's own base, or was accepted,
      //    and a template change over a diverged value is always reported
      if (JSON.stringify(valueAt(after)) !== JSON.stringify(valueAt(before)))
        expect(!diverged || accepted).toBe(true);
      if (held) {
        expect(
          conflicts.filter((c) => c.kind === "conflict").map((c) => c.pointer),
        ).toEqual([ROOT]);
      } else {
        expect(conflicts.filter((c) => c.kind === "conflict")).toEqual([]);
      }

      // 3. removal leaves only keys someone may still own
      if (op === "remove" || change === "dropped") {
        const owner = after.owners?.[ROOT];
        expect(owner?.from.startsWith("acme/t@")).not.toBe(true);
        if (valueAt(after) !== undefined && !diverged) {
          // nobody's edit: kept only for another template, owned when it is available as imported
          expect(other).not.toBe("none");
          expect(owner?.from).toBe(
            other === "sharing" ? "acme/u@1.0.0" : undefined,
          );
        }
        if (op === "remove")
          expect(
            Object.values(after.owners ?? {}).some((o) =>
              o.from.startsWith("acme/t@"),
            ),
          ).toBe(false);
      }

      // 4. a held conflict is atomic: the value and every record at or below its root stay as they were
      if (held) {
        expect(valueAt(after)).toEqual(valueAt(before));
        expect(ownersUnder(after)).toEqual(ownersUnder(before));
      }
    },
  );
});
