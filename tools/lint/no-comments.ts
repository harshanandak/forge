import { relative } from "node:path";
import { requireLintRuntime } from "../bun-builtin.ts";
import { commentDiff, type CommentSnapshot } from "../checks/comment-diff.ts";

interface Comment {
  readonly type: string;
  readonly value: string;
  readonly range: readonly [number, number];
  readonly loc: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
}
interface RuleContext {
  readonly cwd: string;
  readonly filename: string;
  readonly options: readonly {
    readonly base?: string;
    readonly roots?: readonly string[];
  }[];
  readonly sourceCode: {
    readonly text: string;
    getAllComments(): readonly Comment[];
  };
  report(input: {
    readonly loc: Comment["loc"];
    readonly message: string;
  }): void;
}
const snapshots = new Map<string, CommentSnapshot>();
const origin = { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } };
function directive(comment: Comment): boolean {
  if (comment.type === "Shebang" || comment.type === "Hashbang") return true;
  const text = comment.value.trim();
  return (
    /^@ts-expect-error(?:[ \t:][^\r\n]*)?$/.test(text) ||
    (comment.type === "Line" &&
      /^\/[ \t]*<reference(?:[ \t]+(?:path|types|lib|no-default-lib|resolution-mode|preserve)=(?:"[^"\r\n]*"|'[^'\r\n]*'))+[ \t]*\/>$/.test(
        text,
      ))
  );
}
const plugin: {
  meta: { name: string };
  rules: Record<
    string,
    {
      meta: { type: string; schema: readonly object[] };
      create(context: RuleContext): { Program(): void };
    }
  >;
} = {
  meta: { name: "forge" },
  rules: {
    "no-comments": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              base: { type: "string" },
              roots: { type: "array", items: { type: "string" } },
            },
          },
        ],
      },
      create(context) {
        return {
          Program() {
            try {
              const options = context.options[0] ?? {};
              const key = JSON.stringify([context.cwd, options]);
              let snapshot = snapshots.get(key);
              if (!snapshot) {
                requireLintRuntime(process.execPath);
                snapshot = commentDiff(
                  context.cwd,
                  options.base ?? "origin/main",
                  options.roots,
                );
                snapshots.set(key, snapshot);
              }
              const file = relative(context.cwd, context.filename).replaceAll(
                "\\",
                "/",
              );
              const entry = snapshot.files.get(file);
              if (!entry) return;
              const text = context.sourceCode.text;
              if (entry.text !== text && entry.text !== "\uFEFF" + text)
                throw new Error(
                  `Linted source differs from committed HEAD: ${file}`,
                );
              let offset = 0,
                line = 1;
              for (const comment of context.sourceCode.getAllComments()) {
                const [start, end] = comment.range;
                if (
                  !Number.isSafeInteger(start) ||
                  !Number.isSafeInteger(end) ||
                  start < offset ||
                  end < start ||
                  end > text.length
                )
                  throw new Error(`Invalid comment range: ${file}`);
                line += text.slice(offset, start).split("\n").length - 1;
                const endLine =
                  line + text.slice(start, end).split("\n").length - 1;
                if (!directive(comment)) {
                  const kind =
                    comment.type === "Line"
                      ? "line comment"
                      : comment.type === "Block"
                        ? comment.value.startsWith("*")
                          ? "JSDoc"
                          : "block comment"
                        : undefined;
                  if (!kind)
                    throw new Error(`Unknown comment kind: ${comment.type}`);
                  for (let added = line; added <= endLine; added++) {
                    if (!entry.added.has(added)) continue;
                    context.report({
                      loc: comment.loc,
                      message: `new ${kind} (Git line ${added})`,
                    });
                    break;
                  }
                }
                line = endLine;
                offset = end;
              }
              if (snapshot.currentHead() !== snapshot.head)
                throw new Error("HEAD changed during comment check");
            } catch (error) {
              context.report({
                loc: origin,
                message: `INCOMPLETE: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          },
        };
      },
    },
  },
};
export default plugin;
