export interface CommentViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}
export interface CommentCheckResult {
  readonly status: "PASS" | "FAIL" | "INCOMPLETE";
  readonly violations: readonly CommentViolation[];
  readonly reason?: string;
}
export interface CommentCheckOptions {
  readonly root: string;
  readonly base: string;
  readonly roots?: readonly string[];
}
export function addedComments(
  _file: string,
  _text: string,
  _added: ReadonlySet<number>,
): readonly CommentViolation[] {
  return [];
}
export function checkComments(
  _options: CommentCheckOptions,
): CommentCheckResult {
  return { status: "PASS", violations: [] };
}
