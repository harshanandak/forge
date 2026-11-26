const MASK = "[redacted]";
const ADJACENT_MASKS = /(?:\[redacted\]){2,}/g;
const CREDENTIAL =
  /(?:fct_|gh[psour]_|github_pat_|sk-|xox[baprs]-|AKIA|AIza)[a-z\d_-]+/gi;
const BEARER = /\bbearer\s+[^\s,;]+/gi;
const EMAIL =
  /(?:\[redacted\]|[\p{L}\p{N}._%+'-]+)@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/gu;
const ASSIGNMENT =
  /\b(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi;
const PATH =
  /(?<![^\s"'`<>{}=])(?:[a-z][a-z\d+.-]*:\/\/|[^\s"'`<>{}=]*[\\/])(?:\S.*|$)/iu;
const PASTED =
  /[\r\n\u0085\u2028\u2029]|[{}]|<[!?/a-z][^>]*>|^\s*(?:[A-Z_][A-Z0-9_]*\s*=|(?:import|export|function|const|let|var)\s)/u;
const QUOTED =
  /"(?:\\(?:.|$)|[^"\\])*(?:"|$)|(?<!\p{L})'(?:\\(?:.|$)|[^'\\])*(?:'|$)|`(?:\\(?:.|$)|[^`\\])*(?:`|$)/gu;

export function redactReport(
  message: string,
  labels: readonly string[],
): string {
  let text = message.normalize("NFKC");
  if (PASTED.test(text)) return MASK;
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    if (label.trim() === "") continue;
    const literal = label
      .normalize("NFKC")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(literal, "giu"), MASK);
  }
  text = text
    .replace(QUOTED, MASK)
    .replace(
      /%([0-7][a-f\d])|\\(?:u00|x)([0-7][a-f\d])/gi,
      (_match, percent: string | undefined, escape: string | undefined) =>
        String.fromCharCode(Number.parseInt(percent ?? escape ?? "", 16)),
    );
  if (PASTED.test(text)) return MASK;
  text = text
    .replace(/\t/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(QUOTED, MASK)
    .replace(ASSIGNMENT, MASK)
    .replace(BEARER, MASK)
    .replace(EMAIL, MASK)
    .replace(CREDENTIAL, MASK);
  return (
    text
      .replace(PATH, MASK)
      .replace(ADJACENT_MASKS, MASK)
      .replace(/\s+/gu, " ")
      .trim() || MASK
  );
}
