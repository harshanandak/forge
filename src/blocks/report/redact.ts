const MASK = "[redacted]";
const CREDENTIAL =
  /(?:fct_|gh[psour]_|github_pat_|sk-|xox[baprs]-|AKIA|AIza)[a-z\d_-]+/gi;
const AUTHORIZATION = /\b(?:proxy-)?authorization\s*[:=]\s*\S.*$/gi;
const BASIC = /\bbasic\s+[a-z\d+/]+={0,2}(?=\s|[.,;)\]}]|$)/gi;
const BEARER =
  /\bbearer\s+[^\s,;]+(?:[,;]+(?!-)(?![^\s,;]*(?:\b(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key)\s*[:=]|(?<![\w-])--?(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key|auth|pat)(?=[\s,;:=]|$)|\bbearer\s))(?!bearer\s)[^\s,;]+)*/gi;
const QUOTED =
  /"(?:\\(?:.|$)|[^"\\])*(?:"|$)|(?<!\p{L})'(?:\\(?:.|$)|[^'\\])*(?:'|$)|`(?:\\(?:.|$)|[^`\\])*(?:`|$)/gu;
const EMAIL =
  /(?:"(?:\\.|[^"\\])*"|[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+)@(?:\[[^\]\r\n]+\]|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)/gu;
const ASSIGNMENT =
  /\b(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key)\s*[:=]\s*[^\s,;]+(?:[,;]+(?!-)(?![^\s,;]*(?:\b(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key)\s*[:=]|(?<![\w-])--?(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key|auth|pat)(?=[\s,;:=]|$)|\bbearer\s))(?!bearer\s)[^\s,;]+)*/gi;
const FLAG_VALUE =
  /(?<![\w-])--?(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key|auth|pat)\s*(?:[:=]|\s)\s*[^\s,;]+(?:[,;]+(?!-)(?![^\s,;]*(?:\b(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key)\s*[:=]|(?<![\w-])--?(?:password|passwd|secret|credential|(?:access[_-]?)?token|api[_-]?key|auth|pat)(?=[\s,;:=]|$)|\bbearer\s))(?!bearer\s)[^\s,;]+)*/gi;
const ROOTED_PATH =
  /(?<![^\s([<{"'=:,;`>|])(?:~?\/|\.\.?[\\/]|[a-z]:[\\/]|\\\\)(?:(?:[^()[\]"'`<>{}=]|\[[^\]]*\]|\([^)]*\))*[\\/])?[^\s)\]}>"'`<={]*/iu;
const UNROOTED_PATH =
  /(?<![^\s"'`<>{}=])(?:[a-z][a-z\d+.-]*:\/\/|[\p{L}\p{N}][^\s"'`<>{}=:,;]*[\\/])[^\s"'`<>{}=]+/iu;
const PATH = new RegExp(
  QUOTED.source +
    "|(?<path>" +
    ROOTED_PATH.source +
    "|" +
    UNROOTED_PATH.source +
    ")",
  "giu",
);
const PASTED =
  /[\r\n\u0085\u2028\u2029]|[{}]|<[!?/a-z][^>]*>|^\s*(?:[A-Z_][A-Z0-9_]*\s*=|(?:import|export|function|const|let|var)\s)/u;
const ESCAPE = /%([0-7][a-f\d])|\\(?:u00|x)([0-7][a-f\d])/gi;
const QUOTED_PART = new RegExp("(" + QUOTED.source + ")", "gu");

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .split(QUOTED_PART)
    .map((part, index) => {
      const delimiter = index % 2 === 0 ? undefined : part[0];
      return part.replace(
        ESCAPE,
        (_match, percent: string | undefined, escape: string | undefined) => {
          const decoded = String.fromCharCode(
            Number.parseInt(percent ?? escape ?? "", 16),
          );
          return delimiter && (decoded === delimiter || decoded === "\\")
            ? "\\" + decoded
            : decoded;
        },
      );
    })
    .join("")
    .replace(/\t/g, " ")
    .replace(/(?![\r\n\u0085])[\p{Cc}\p{Cf}]/gu, "")
    .normalize("NFKC");
}

export function redactReport(
  message: string,
  labels: readonly string[],
): string {
  if (PASTED.test(message)) return MASK;
  const text = normalize(message);
  if (PASTED.test(text)) return MASK;
  const patterns = [
    CREDENTIAL,
    ASSIGNMENT,
    FLAG_VALUE,
    AUTHORIZATION,
    BASIC,
    BEARER,
    QUOTED,
    EMAIL,
  ];
  for (const label of labels) {
    const literal = normalize(label);
    if (literal.trim())
      patterns.push(
        new RegExp(
          literal
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\s+/g, "\\s+"),
          "giu",
        ),
      );
  }
  const spans: [start: number, end: number][] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern))
      spans.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(PATH)) {
    if (match.groups?.path)
      spans.push([match.index, match.index + match[0].length]);
  }
  spans.sort(([left], [right]) => left - right);
  let result = "";
  let end = 0;
  for (const [start, stop] of spans) {
    if (start > end || end === 0) result += text.slice(end, start) + MASK;
    end = Math.max(end, stop);
  }
  return (result + text.slice(end)).replace(/\s+/gu, " ").trim() || MASK;
}
