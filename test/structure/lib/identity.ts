import { posix } from "node:path";
import { importsOf, parsedSource } from "./imports.ts";
import { maskSource } from "./platform.ts";
import type { SourceFile, Violation } from "./repo.ts";
import { isTestFile } from "./repo.ts";

// Predicate-only imports expose no minting capability.
const predicateOnly =
  /^[ \t]*(?:import|export)\s*\{\s*isVerifiedIdentity(?:\s+as\s+\w+)?\s*\}\s*from\s*["'][^"']+["']\s*;?/gm;

function mintTarget(path: string, specifier: string): boolean {
  return /^src\/ports\/identity-mint\.(?:ts|js)$/.test(
    posix.normalize(
      posix.join(posix.dirname(path), specifier.replaceAll("\\", "/")),
    ),
  );
}

interface IdentityToken {
  readonly kind: "identifier" | "number" | "literal" | "regex" | "punctuator";
  readonly text: string;
  readonly context?: "expression" | "ambiguous";
}

class IdentityTokenRefusal extends Error {
  readonly kind = "identity-token-refusal";
}

const controls = new Set(["if", "while", "for", "with", "switch", "catch"]);
const regexPrefix = new Set([
  "return",
  "throw",
  "typeof",
  "void",
  "delete",
  "new",
  "in",
  "instanceof",
  "yield",
  "await",
  "case",
  "else",
  "do",
  "of",
  "default",
  "extends",
]);
const identifier =
  /^(?:[$_\p{ID_Start}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))(?:[$\u200c\u200d\p{ID_Continue}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))*/u;
const unicodeEscape = /^u(?:([\da-fA-F]{4})|\{([\da-fA-F]+)\})/;

/** Literals are indivisible; only template substitutions re-enter code scanning. */
function identityTokens(source: string): {
  tokens: IdentityToken[];
  pairs: Map<number, number>;
} {
  const tokens: IdentityToken[] = [];
  const pairs = new Map<number, number>();
  const braces: {
    text: string;
    index: number;
    context: "expression" | "ambiguous";
  }[] = [];
  let i = 0;
  const refuse: (reason: string) => never = (reason) => {
    throw new IdentityTokenRefusal(`${reason} at offset ${i}`);
  };
  const emit = (kind: IdentityToken["kind"], text: string): void => {
    tokens.push({ kind, text });
  };
  const escape = (): string => {
    const match = unicodeEscape.exec(source.slice(i));
    if (match) {
      i += match[0].length;
      const point = Number.parseInt(match[1] ?? match[2]!, 16);
      if (point > 0x10ffff) refuse("invalid Unicode escape");
      return String.fromCodePoint(point);
    }
    return refuse("unclassified identifier escape");
  };
  const quoted = (quote: string): void => {
    let text = "";
    i++;
    while (i < source.length) {
      const ch = source[i++]!;
      if (ch === quote) {
        emit("literal", text);
        return;
      }
      if (ch === "\n" || ch === "\r") refuse("unterminated string");
      if (ch !== "\\") {
        text += ch;
        continue;
      }
      const next = source[i]!;
      if (next === "u") text += escape();
      else if (next === "x") {
        if (!/^[\da-fA-F]{2}$/.test(source.slice(i + 1, i + 3)))
          refuse("invalid string escape");
        text += String.fromCharCode(
          Number.parseInt(source.slice(i + 1, i + 3), 16),
        );
        i += 3;
      } else {
        i++;
        const escapes: Record<string, string> = {
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
          v: "\v",
          "0": "\0",
        };
        if (next === "\r" && source[i] === "\n") i++;
        text += next === "\n" || next === "\r" ? "" : (escapes[next] ?? next);
      }
    }
    refuse("unterminated string");
  };
  const regex = (): void => {
    let inClass = false;
    i++;
    while (i < source.length) {
      const ch = source[i++]!;
      if (ch === "\n" || ch === "\r") refuse("unterminated regex");
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "[") {
        if (inClass) refuse("unclassified nested regex character class");
        inClass = true;
      }
      if (ch === "]") inClass = false;
      if (ch === "/" && !inClass) {
        while (/[a-z]/i.test(source[i] ?? "")) i++;
        emit("regex", "<regex>");
        return;
      }
    }
    refuse("unterminated regex");
  };
  const template = (): void => {
    emit("literal", "<template>");
    i++;
    while (i < source.length) {
      const ch = source[i++]!;
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "`") {
        emit("literal", "<template>");
        return;
      }
      if (ch === "$" && source[i] === "{") {
        i++;
        braces.push({
          text: "${",
          index: tokens.length,
          context: "expression",
        });
        emit("punctuator", "${");
        code(true);
      }
    }
    refuse("unterminated template");
  };
  const code = (substitution = false): void => {
    while (i < source.length) {
      const ch = source[i]!;
      const previous = tokens.at(-1);
      if (/\s/u.test(ch)) {
        i++;
        continue;
      }
      if (source.startsWith("//", i)) {
        while (i < source.length && !/[\n\r\u2028\u2029]/u.test(source[i]!))
          i++;
        continue;
      }
      if (source.startsWith("/*", i)) {
        const end = source.indexOf("*/", i + 2);
        if (end < 0) refuse("unterminated comment");
        i = end + 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quoted(ch);
        continue;
      }
      if (ch === "`") {
        template();
        continue;
      }
      if (ch === "/") {
        if (previous?.context === "ambiguous")
          refuse("ambiguous regex or division");
        const division =
          previous &&
          (previous.kind === "number" ||
            previous.kind === "literal" ||
            previous.kind === "regex" ||
            (previous.kind === "identifier" &&
              (!regexPrefix.has(previous.text) ||
                [".", "?."].includes(tokens.at(-2)?.text ?? ""))) ||
            [")", "]", "++", "--"].includes(previous.text) ||
            (previous.text === "}" && previous.context === "expression"));
        if (!division) {
          regex();
          continue;
        }
        emit("punctuator", source[i + 1] === "=" ? "/=" : "/");
        i += source[i + 1] === "=" ? 2 : 1;
        continue;
      }
      const name = identifier.exec(source.slice(i))?.[0];
      if (name) {
        const start = i;
        i += name.length;
        const canonical = name.replace(
          /\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\})/g,
          (raw) => {
            const end = i;
            i = start + name.indexOf(raw) + 1;
            const decoded = escape();
            i = end;
            return decoded;
          },
        );
        if (
          !/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(canonical)
        )
          refuse("invalid identifier");
        emit("identifier", canonical);
        continue;
      }
      const number =
        /^(?:0[xob][\da-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[+-]?[\d_]+)?n?)/i.exec(
          source.slice(i),
        )?.[0];
      if (number) {
        emit("number", number);
        i += number.length;
        continue;
      }
      const punctuator =
        /^(?:=>|\?\.|===|!==|\*\*=|>>>?=?|<<=?|&&=?|\|\|=?|\?\?=?|\.\.\.|[+*%&|^!=<>-]=|\+\+|--|\*\*|[{}()[\].,;:?~!+*%&|^=<>#-])/.exec(
          source.slice(i),
        )?.[0];
      if (!punctuator) refuse("unclassified token");
      i += punctuator.length;
      if (["(", "[", "{"].includes(punctuator)) {
        const control =
          previous &&
          (controls.has(previous.text) ||
            (previous.text === "await" && tokens.at(-2)?.text === "for"));
        const expression =
          punctuator === "[" ||
          (punctuator === "(" && !control) ||
          (punctuator === "{" &&
            ["=", "(", "[", "return", "yield"].includes(previous?.text ?? ""));
        braces.push({
          text: punctuator,
          index: tokens.length,
          context: expression ? "expression" : "ambiguous",
        });
      } else if ([")", "]", "}"].includes(punctuator)) {
        const open = braces.pop();
        const expected =
          punctuator === ")" ? "(" : punctuator === "]" ? "[" : "{";
        if (
          !open ||
          (open.text !== expected &&
            !(open.text === "${" && punctuator === "}"))
        )
          refuse("unmatched delimiter");
        pairs.set(open.index, tokens.length);
        pairs.set(tokens.length, open.index);
        tokens.push({
          kind: "punctuator",
          text: punctuator,
          context: open.context,
        });
        if (open.text === "${") return;
        continue;
      }
      emit("punctuator", punctuator);
    }
    if (substitution || braces.length) refuse("unclosed delimiter");
  };
  code();
  return { tokens, pairs };
}

function oauthMintRefusal(file: SourceFile): IdentityTokenRefusal | undefined {
  try {
    const hasMint = importsOf(file).some((s) => mintTarget(file.path, s));
    if (hasMint) {
      const text = file.text.replace(
        'import { mintIdentity } from "../../../../src/ports/identity-mint.ts";',
        "",
      );
      if (
        text === file.text ||
        importsOf({ ...file, text }).some((s) => mintTarget(file.path, s))
      )
        throw new IdentityTokenRefusal(
          "mint import is not the exact private binding",
        );
    }
    // Type erasure must not hide an ambiguous slash or an invalid raw token.
    const raw = identityTokens(file.text).tokens;
    for (let i = 0; i < raw.length; i++) {
      const token = raw[i]!;
      if (
        token.kind !== "identifier" ||
        !["import", "require"].includes(token.text)
      )
        continue;
      if (raw[i + 1]?.text === "(") {
        const target = raw[i + 2];
        if (
          target?.kind !== "literal" ||
          ![",", ")"].includes(raw[i + 3]?.text ?? "") ||
          mintTarget(file.path, target.text)
        )
          throw new IdentityTokenRefusal("unclassified module load");
      } else if (token.text === "require")
        throw new IdentityTokenRefusal("escaped module loader");
    }
    // Erase types without erasing value references; tokenize before any text masking.
    const { tokens, pairs } = identityTokens(parsedSource(file));
    const scopes: { start: number; end: number; name: string }[] = [];
    const parameters = new Set<number>();
    const at = (index: number): string => {
      const token = tokens[index];
      return token?.kind === "identifier" || token?.kind === "punctuator"
        ? token.text
        : "";
    };
    const refuse: (reason: string) => never = (reason) => {
      throw new IdentityTokenRefusal(reason);
    };
    for (let i = 0; i < tokens.length; i++) {
      if (at(i) !== "function" || [".", "?."].includes(at(i - 1))) continue;
      let parameter = i + 1;
      if (at(parameter) === "*") parameter++;
      const name =
        tokens[parameter]?.kind === "identifier" ? at(parameter++) : "";
      const close = pairs.get(parameter);
      const end = close === undefined ? undefined : pairs.get(close + 1);
      if (
        at(parameter) !== "(" ||
        close === undefined ||
        at(close + 1) !== "{" ||
        end === undefined
      )
        refuse("unclassified function body");
      parameters.add(parameter);
      scopes.push({ start: i, end, name });
    }
    for (let i = 0; i < tokens.length; i++) {
      if (at(i) === "=>") {
        let end = pairs.get(i + 1);
        if (at(i + 1) !== "{") {
          end = i + 1;
          while (
            end < tokens.length &&
            ![",", ";", ")", "]", "}"].includes(at(end))
          ) {
            end = (pairs.get(end) ?? end) + 1;
          }
          end--;
        }
        if (end === undefined || end <= i) refuse("unclassified arrow body");
        scopes.push({
          start: at(i - 1) === ")" ? pairs.get(i - 1)! : i - 1,
          end,
          name: "",
        });
      }
      if (at(i) === "(" && !parameters.has(i) && !controls.has(at(i - 1))) {
        const close = pairs.get(i)!;
        const end = pairs.get(close + 1);
        if (at(close + 1) === "{" && end !== undefined)
          scopes.push({ start: i, end, name: "" });
      }
      if (at(i) === "class" && ![".", "?."].includes(at(i - 1))) {
        let body = i + 1;
        while (body < tokens.length && at(body) !== "{")
          body = (pairs.get(body) ?? body) + 1;
        const end = pairs.get(body);
        if (end === undefined) refuse("unclassified class body");
        scopes.push({ start: i, end, name: "" });
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      if (at(i) === "import" && at(i + 1) !== "(" && at(i + 1) !== ".") {
        while (i < tokens.length && at(i) !== ";") i++;
        continue;
      }
      if (tokens[i]?.kind !== "identifier" || at(i) !== "mintIdentity")
        continue;
      const parents = scopes
        .filter((scope) => scope.start <= i && i <= scope.end)
        .sort((a, b) => a.start - b.start);
      if (
        !hasMint ||
        at(i + 1) !== "(" ||
        [".", "?.", "new"].includes(at(i - 1)) ||
        parents.length !== 2 ||
        parents[0]?.name !== "createOAuthAdapter" ||
        parents[1]?.name !== "verifyProviderToken"
      )
        refuse("mint reference escapes the verifier boundary");
    }
    return undefined;
  } catch (cause) {
    return cause instanceof IdentityTokenRefusal
      ? cause
      : new IdentityTokenRefusal("unclassifiable OAuth source");
  }
}

function reexportsMint(file: SourceFile): boolean {
  if (file.path === "cloud/src/adapters/workers-oauth/index.ts")
    return oauthMintRefusal(file) !== undefined;
  if (!importsOf(file).some((s) => mintTarget(file.path, s))) return false;
  // Other loading forms expose the module rather than a direct mint binding.
  const withoutImports = maskSource(file.text, false).replace(
    /\bimport\s+[^;]*?\s+from\s*["'][^"']+["']\s*;?/g,
    "",
  );
  if (
    importsOf({ ...file, text: withoutImports }).some((s) =>
      mintTarget(file.path, s),
    )
  )
    return true;
  const source = maskSource(parsedSource(file), false);
  const bindings = new Set<string>();
  // Remove binding declarations, leaving every use for the direct-call check.
  const references = source.replace(
    /\bimport\s+([^;]*?)\s+from\s*["'][^"']+["']\s*;?/g,
    (declaration: string, clause: string) => {
      if (
        !importsOf({ ...file, text: declaration }).some((s) =>
          mintTarget(file.path, s),
        )
      )
        return declaration;
      const namespace = /\*\s+as\s+([$\w]+)/.exec(clause);
      if (namespace) bindings.add(namespace[1]!);
      for (const name of clause.matchAll(
        /\bmintIdentity(?:\s+as\s+([$\w]+))?/g,
      ))
        bindings.add(name[1] ?? "mintIdentity");
      return "";
    },
  );
  const code = maskSource(references, true);
  for (const match of code.matchAll(
    /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/gu,
  ))
    if (
      bindings.has(match[0]) &&
      (!/^\s*\(/.test(code.slice(match.index + match[0].length)) ||
        /\bnew\s*$/.test(code.slice(0, match.index)))
    )
      return true;
  return false;
}

export function findIdentityMintViolations(
  files: readonly SourceFile[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = posix.normalize(file.path.replaceAll("\\", "/"));
    const source = { path, text: file.text };
    if (path !== "cloud/src/adapters/workers-oauth/index.ts")
      source.text = source.text.replace(predicateOnly, "");
    const verifier =
      (path.startsWith("src/adapters/oidc/") && !isTestFile(path)) ||
      path === "src/adapters/oidc/identity-mint.test.ts" ||
      path === "cloud/src/adapters/workers-oauth/index.ts" ||
      path === "test/contract/lib/identity-verifier.ts";
    if (
      verifier
        ? reexportsMint(source)
        : importsOf(source).some((specifier) => mintTarget(path, specifier))
    )
      violations.push({
        rule: "identity-provenance",
        file: file.path,
        message:
          "identity-mint may be imported only by verifiers and never re-exported",
      });
  }
  return violations;
}
