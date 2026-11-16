import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve, relative } from "node:path";
import * as ts from "typescript/unstable/ast";
import {
  API,
  TypeFlags,
  type Project,
  type Type,
} from "typescript/unstable/sync";

export interface WriterSite {
  site: string;
  hash: string;
  families: string[];
  refusal?: string;
}

export function scanWriters(
  project: Project,
  root: string,
  onlyFile?: string,
): WriterSite[] {
  const writers = ["put", "putNext", "putMany", "delete"];
  const opaqueFlags = TypeFlags.Any | TypeFlags.Unknown;
  const local = (file: string) =>
    relative(root, file).replaceAll("\\", "/").startsWith("src/");
  const { checker, program } = project;
  const has = (type: Type | undefined, name: string) =>
    type && checker.getPropertyOfType(type, name);
  const result: WriterSite[] = [];
  const family = (key: ts.Node | undefined): string | undefined => {
    if (!key) return;
    if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))
      return key.text.split(":")[0] || undefined;
    if (ts.isTemplateExpression(key) && key.head.text.includes(":"))
      return key.head.text.split(":")[0] || undefined;
    return;
  };
  const siteOf = (node: ts.Node): WriterSite => ({
    site:
      relative(root, node.getSourceFile().fileName).replaceAll("\\", "/") +
      ":" +
      (node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
        .line +
        1),
    hash: createHash("sha256")
      .update(node.getSourceFile().text.replaceAll("\r\n", "\n"))
      .digest("hex"),
    families: [],
  });
  const refuse = (row: WriterSite) => {
    row.refusal = "literal-only writer required at " + row.site;
  };
  const assignmentPattern = (node: ts.Node): boolean => {
    if (
      !ts.isObjectLiteralExpression(node) &&
      !ts.isArrayLiteralExpression(node)
    )
      return false;
    for (let part: ts.Node = node; part.parent; part = part.parent) {
      const parent = part.parent;
      if (
        (ts.isBinaryExpression(parent) &&
          parent.left === part &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        (ts.isForOfStatement(parent) && parent.initializer === part)
      )
        return true;
      if (
        !ts.isObjectLiteralExpression(part) &&
        !ts.isArrayLiteralExpression(part) &&
        !ts.isPropertyAssignment(part) &&
        !ts.isSpreadAssignment(part) &&
        !ts.isSpreadElement(part)
      )
        return false;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    node.forEachChild(visit);
    const pattern =
      ts.isObjectBindingPattern(node) ||
      ts.isArrayBindingPattern(node) ||
      assignmentPattern(node);
    const type = pattern ? checker.getTypeAtLocation(node) : undefined;
    if (
      pattern &&
      (!type ||
        type.flags & opaqueFlags ||
        writers.some((name) => has(type, name)))
    ) {
      const row = siteOf(node);
      refuse(row);
      result.push(row);
    }
    if (
      !ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)
    )
      return;
    const method = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    if (method && !writers.includes(method)) return;
    const receiverType = checker.getTypeAtLocation(node.expression);
    const opaque = !!(!receiverType || receiverType.flags & opaqueFlags);
    const state = ["put", "putNext", "putMany"].some((name) =>
      has(receiverType, name),
    );
    const memberFile =
      checker.getSymbolAtLocation(node)?.valueDeclaration?.path;
    if (
      method
        ? !writers.includes(method) ||
          (method === "delete" &&
            !state &&
            !opaque &&
            !(memberFile && local(memberFile)))
        : !state && !opaque
    )
      return;
    const call =
      ts.isCallExpression(node.parent) && node.parent.expression === node
        ? node.parent
        : undefined;
    const namespaced =
      call &&
      checker.getResolvedSignature(call)?.getParameters()[0]?.name ===
        "namespace";
    let namespace = namespaced ? call.arguments[0] : undefined;
    const declaration = ts.isIdentifier(node.expression)
      ? checker
          .getSymbolAtLocation(node.expression)
          ?.valueDeclaration?.resolve()
      : undefined;
    const receiver =
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
        ? declaration.initializer
        : undefined;
    if (
      !namespace &&
      receiver &&
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === "client"
    )
      namespace = receiver.arguments[0];
    if (
      !(opaque && ts.isElementAccessExpression(node)) &&
      namespace &&
      ts.isStringLiteral(namespace) &&
      namespace.text !== "forge/work"
    )
      return;
    const row = siteOf(call ?? node);
    if (!call || !method || ts.isElementAccessExpression(node)) refuse(row);
    else {
      const key = call.arguments[namespaced ? 1 : 0];
      if (method !== "putMany") {
        const name = family(key);
        if (name) row.families.push(name);
        else refuse(row);
      } else if (key && ts.isArrayLiteralExpression(key)) {
        for (const entry of key.elements) {
          if (
            !ts.isObjectLiteralExpression(entry) ||
            entry.properties.some(
              (p) =>
                (!ts.isPropertyAssignment(p) &&
                  !ts.isShorthandPropertyAssignment(p)) ||
                ts.isComputedPropertyName(p.name),
            )
          ) {
            refuse(row);
            continue;
          }
          const keys = entry.properties.filter(
            (p) =>
              "name" in p &&
              p.name?.getText().replaceAll('"', "").replaceAll("'", "") ===
                "key",
          );
          const name =
            keys.length === 1 && ts.isPropertyAssignment(keys[0]!)
              ? family(keys[0].initializer)
              : undefined;
          if (name) row.families.push(name);
          else refuse(row);
        }
      } else refuse(row);
    }
    result.push(row);
  };
  for (const file of program.getSourceFileNames()) {
    if (!local(file) || (onlyFile && file.replaceAll("\\", "/") !== onlyFile))
      continue;
    const source = program.getSourceFile(file);
    if (!source) throw new Error("unreadable writer source " + file);
    visit(source);
  }
  return result;
}

export function scanProjectWriters(
  root: string,
  fixture?: { file: string; text: string },
): WriterSite[] {
  if (process.versions.bun) {
    const reply = spawnSync("node", [fileURLToPath(import.meta.url), root], {
      input: JSON.stringify(fixture ?? null),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (reply.error) throw reply.error;
    if (reply.status !== 0)
      throw new Error(reply.stderr || "Writer scan refused");
    return JSON.parse(reply.stdout) as WriterSite[];
  }
  const normalized = (file: string) => resolve(file).replaceAll("\\", "/");
  const source = join(root, "src"),
    config = normalized(join(root, ".writer-scan.tsconfig.json"));
  const file = fixture && normalized(join(source, fixture.file));
  const files = readdirSync(source, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.[cm]?ts$/.test(p))
    .map((p) => normalized(join(source, p)));
  if (file && !files.includes(file)) files.push(file);
  const api = new API({
    cwd: root,
    fs: {
      fileExists: (path) =>
        normalized(path) === config || normalized(path) === file
          ? true
          : undefined,
      readFile: (path) =>
        normalized(path) === config
          ? JSON.stringify({
              files,
              compilerOptions: {
                module: "nodenext",
                moduleResolution: "nodenext",
                allowImportingTsExtensions: true,
              },
            })
          : normalized(path) === file
            ? fixture!.text
            : undefined,
    },
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (!project) throw new Error("writer project unavailable " + config);
      return scanWriters(project, root, file);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.stdout.write(
    JSON.stringify(
      scanProjectWriters(
        process.argv[2]!,
        (JSON.parse(readFileSync(0, "utf8")) as {
          file: string;
          text: string;
        } | null) ?? undefined,
      ),
    ),
  );
