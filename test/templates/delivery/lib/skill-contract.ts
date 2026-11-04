import { posix } from "node:path";
import { parse } from "yaml";

export type Files = Readonly<Record<string, string>>;
export interface Rule {
  id: string;
  home: string;
  anchor: string;
  copies?: string[];
  value?: string | number;
}
export interface Budgets {
  migrated: string[];
  router: number;
  reference: number;
  description: number;
  routes: Record<string, { files: string[]; bytes: number }>;
}
export const lf = (text: string): string => text.replace(/\r\n/g, "\n");
export const bytes = (text: string): number => Buffer.byteLength(lf(text));
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const links = (text: string) => [...text.matchAll(LINK)];
const headings = (text: string) => [...text.matchAll(/^#{1,6} (.+)$/gm)];
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");

export function checkShape(
  files: Files,
  migrated: readonly string[],
): string[] {
  const errors: string[] = [];
  for (const name of migrated) {
    const path = `${name}/SKILL.md`;
    const text = lf(files[path] ?? "");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    const meta = parse(front?.[1] ?? "") as {
      name?: string;
      description?: string;
    } | null;
    if (meta?.name !== name)
      errors.push(`${path}: frontmatter name must match folder`);
    if (!/^Use (when|after) /.test(meta?.description ?? ""))
      errors.push(`${path}: description needs a trigger`);
    const actual = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    for (const title of ["Steps", "Hard rules", "Read on demand"])
      if (!actual.includes(title)) errors.push(`${path}: missing ## ${title}`);
    if (actual.join("|") !== "Steps|Hard rules|Read on demand")
      errors.push(`${path}: unexpected section order`);
    if (
      headings(text)
        .filter((h) => h[0].startsWith("# "))
        .map((h) => h[1])
        .join() !== name
    )
      errors.push(`${path}: expected one matching title`);
    const steps = text.split("## Steps\n")[1]?.split("\n## ")[0] ?? "";
    const demand = text.split("## Read on demand\n")[1] ?? "";
    for (const line of text.split("\n")) {
      if (!links(line).length) continue;
      if (!steps.includes(line) && !demand.includes(line))
        errors.push(`${path}: link outside Steps or Read on demand`);
      if (
        steps.includes(line) &&
        !/^\d+\. .*\b(when|before|after|on|if)\b/i.test(line.replace(LINK, ""))
      )
        errors.push(`${path}: step link has no trigger`);
    }
  }
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith("/SKILL.md")) continue;
    if (
      /^---\n/.test(lf(text)) ||
      headings(text).filter((h) => h[0].startsWith("# ")).length !== 1
    )
      errors.push(`${path}: reference needs one title and no frontmatter`);
  }
  return errors;
}

export function checkLinks(files: Files): string[] {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    for (const match of links(text)) {
      const link = match[1]!;
      if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue;
      const [file, anchor] = link.split("#");
      const target = file
        ? posix.normalize(posix.join(posix.dirname(path), file))
        : path;
      if (
        (file?.startsWith("..") &&
          !/^\.\.\/forge-[a-z-]+\/[^/]+\.md$/.test(file)) ||
        file?.startsWith("/")
      )
        errors.push(`${path}: invalid cross-skill link ${link}`);
      if (!(target in files)) errors.push(`${path}: broken link ${link}`);
      else if (
        anchor &&
        !headings(files[target]!).some((h) => slug(h[1]!) === anchor)
      )
        errors.push(`${path}: missing anchor ${link}`);
    }
    if (path.endsWith("/SKILL.md")) continue;
    const router = `${posix.dirname(path)}/SKILL.md`;
    const demand = files[router]?.split("## Read on demand\n")[1] ?? "";
    // Old routers keep their existing companion arrangement until they migrate.
    if (
      files[router]?.includes("## Read on demand\n") &&
      !links(demand).some((m) => m[1] === posix.basename(path))
    )
      errors.push(`${path}: orphan reference`);
  }
  return errors;
}

export function checkRules(files: Files, rules: readonly Rule[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) errors.push(`rule ${rule.id}: duplicate id`);
    ids.add(rule.id);
    const allowed = [rule.home, ...(rule.copies ?? [])];
    for (const home of allowed) {
      if (!(files[home] ?? "").includes(rule.anchor))
        errors.push(`rule ${rule.id}: not found in ${home}`);
    }
    for (const [path, text] of Object.entries(files)) {
      const count = rule.anchor ? text.split(rule.anchor).length - 1 : 0;
      if (count > (allowed.includes(path) ? 1 : 0))
        errors.push(`rule ${rule.id}: duplicate in ${path}`);
    }
    if (!rule.anchor) errors.push(`rule ${rule.id}: empty anchor`);
  }
  return errors;
}

export function checkBudgets(
  source: Files,
  rendered: Files,
  budgets: Budgets,
): string[] {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(source)) {
    if (!budgets.migrated.includes(path.split("/")[0]!)) continue;
    const router = path.endsWith("/SKILL.md");
    const limit = router ? budgets.router : budgets.reference;
    if (router && !(path in rendered))
      errors.push(`${path}: missing rendered router`);
    if (bytes(router ? (rendered[path] ?? "") : text) > limit)
      errors.push(
        `${path}: exceeds ${limit} ${router ? "rendered" : "source"} bytes`,
      );
    if (router) {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(lf(text));
      const meta = parse(front?.[1] ?? "") as { description?: string } | null;
      if ([...(meta?.description ?? "")].length > budgets.description)
        errors.push(
          `${path}: description exceeds ${budgets.description} characters`,
        );
    }
  }
  for (const [name, route] of Object.entries(budgets.routes)) {
    if (route.files.some((path) => !(path in rendered)))
      errors.push(`${name}: missing route file`);
    if (
      route.files.reduce((sum, path) => sum + bytes(rendered[path] ?? ""), 0) >
      route.bytes
    )
      errors.push(`${name}: exceeds ${route.bytes} route bytes`);
  }
  return errors;
}

export function checkNeutral(files: Files): string[] {
  return Object.entries(files)
    .filter(([, text]) =>
      /watch_pull_request|Claude Code|\bCodex\b|\bT3\b|templates\/|\{\{|<!--\s*rule:|rule-tag/.test(
        text,
      ),
    )
    .map(([path]) => `${path}: non-neutral text`);
}
