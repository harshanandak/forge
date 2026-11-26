const MASK = "[redacted]";
const CREDENTIAL =
  /(?:fct_|ghp_|github_pat_|sk-|xox[baprs]-|AKIA|AIza)[a-z\d_-]+/gi;
const ASSIGNMENT =
  /\b(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const PATH =
  /(?:[a-z][a-z\d+.-]*:\/\/|[a-z]:[\\/]|(?:~|\.\.?)[\\/]|[\\/]|[\p{L}\p{N}_.-]+[\\/])[^\s"'`<>{}()[\],;]*/giu;
const PASTED =
  /[\r\n\u0085\u2028\u2029]|[{}]|<[!?/a-z][^>]*>|^\s*(?:[A-Z_][A-Z0-9_]*\s*=|(?:import|export|function|const|let|var)\s)/u;
const QUOTED = /"[^"]*"|(?<!\p{L})'[^']*'|`[^`]*`/gu;

export function redactReport(
  message: string,
  labels: readonly string[],
): string {
  let text = message
    .normalize("NFKC")
    .replace(
      /%([0-7][a-f\d])|\\(?:u00|x)([0-7][a-f\d])/gi,
      (_match, percent: string | undefined, escape: string | undefined) =>
        String.fromCharCode(Number.parseInt(percent ?? escape ?? "", 16)),
    );
  if (PASTED.test(text)) return MASK;
  text = text.replace(/\t/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "");
  text = text
    .replace(ASSIGNMENT, MASK)
    .replace(QUOTED, MASK)
    .replace(PATH, MASK)
    .replace(CREDENTIAL, MASK);
  for (const label of labels) {
    if (label.trim() === "") continue;
    const literal = label
      .normalize("NFKC")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(literal, "giu"), MASK);
  }
  return text.replace(/\s+/gu, " ").trim() || MASK;
}
