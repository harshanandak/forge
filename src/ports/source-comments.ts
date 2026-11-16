export interface SourceComment {
  readonly kind: "line comment" | "block comment" | "JSDoc";
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}
export interface SourceCommentsPort {
  comments(file: string, text: string): readonly SourceComment[];
}
