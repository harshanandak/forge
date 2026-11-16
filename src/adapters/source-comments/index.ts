import { parse } from "@babel/parser";
import type { SourceCommentsPort } from "../../ports/source-comments.ts";

export const sourceComments: SourceCommentsPort = {
  comments(file, text) {
    const parsed = parse(text, {
      sourceType: /\.cjs$/i.test(file) ? "commonjs" : "unambiguous",
      attachComment: false,
      plugins: [
        ...(/\.[cm]?tsx?$/i.test(file) ? ["typescript" as const] : []),
        ...(/\.[jt]sx$/i.test(file) ? ["jsx" as const] : []),
      ],
    });
    let position = 0,
      line = 1;
    const lineAt = (next: number): number => {
      line += text.slice(position, next).split("\n").length - 1;
      position = next;
      return line;
    };
    return (parsed.comments ?? []).map((comment) => {
      if (
        typeof comment.start !== "number" ||
        typeof comment.end !== "number" ||
        comment.start < position ||
        comment.end < comment.start
      )
        throw new Error(`Missing comment range: ${file}`);
      return {
        kind:
          comment.type === "CommentLine"
            ? "line comment"
            : comment.value.startsWith("*")
              ? "JSDoc"
              : "block comment",
        startLine: lineAt(comment.start),
        endLine: lineAt(comment.end),
        text: comment.value,
      };
    });
  },
};
