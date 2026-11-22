import { isProxy } from "node:util/types";

type Predicate<T> = (value: unknown, ceiling: number) => value is T;
type Shape = Predicate<unknown> | [Shape] | { [key: string]: Shape };
type Value<S> =
  S extends Predicate<infer T>
    ? T
    : S extends [infer Item]
      ? Value<Item>[]
      : { [Key in keyof S]: Value<S[Key]> };
function oneOf<const T extends (string | boolean)[]>(...items: T) {
  return (value: unknown): value is T[number] =>
    items.includes(value as T[number]);
}
const list = <S extends Shape>(item: S): [S] => [item];
function nullable<T>(check: Predicate<T>): Predicate<T | null> {
  return (value, ceiling) => value === null || check(value, ceiling);
}
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const utc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
function instant(value: unknown, ceiling: number): value is string {
  if (typeof value !== "string" || !utc.test(value)) return false;
  const date = new Date(value);
  const canonical = value.length === 20 ? value.slice(0, -1) + ".000Z" : value;
  return date.getTime() <= ceiling && date.toISOString() === canonical;
}
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bool = oneOf(true, false);
const shape = {
  version: oneOf("review-gate-input/1"),
  prHead: sha,
  now: instant,
  pushedAt: instant,
  reviews: list({
    reviewer: oneOf("codex", "coderabbit"),
    status: oneOf("none", "in_progress", "completed"),
    reviewedHead: nullable(sha),
    reviewedAt: nullable(instant),
    quotaAt: nullable(instant),
    findingAts: list(instant),
  }),
  codexFindings: oneOf("clean", "findings_resolved", "unresolved"),
  history: list({
    head: sha,
    at: instant,
    kind: oneOf("sol", "lead-check", "sonnet-temp", "review-gate"),
    verdict: oneOf("PASS", "BLOCK"),
    p1: count,
    scope: oneOf("full", "findings"),
  }),
  guard: { mainRed: bool, securityPathNeedsSol: bool, securitySolPass: bool },
  unresolvedThreads: count,
  threadsComplete: oneOf(true),
};
export type ReviewGateInput = Value<typeof shape>;

function readInput(value: unknown): ReviewGateInput | string {
  let ceiling = Infinity;
  function invalid(path: string): never {
    throw new Error(path);
  }
  function read(schema: Shape, item: unknown, path: string): unknown {
    if (typeof schema === "function") {
      if (!schema(item, ceiling)) invalid(path);
      if (path === "now") ceiling = Date.parse(item as string);
      return item;
    }
    if (item === null || typeof item !== "object" || isProxy(item))
      invalid(path);
    const keys = Reflect.ownKeys(item);
    function child(key: string, name: string, rule: Shape) {
      const own = Object.getOwnPropertyDescriptor(item, key);
      if (!own?.enumerable || !Object.hasOwn(own, "value")) invalid(name);
      return read(rule, own.value, name);
    }
    if (Array.isArray(schema)) {
      if (!Array.isArray(item)) invalid(path);
      const items: unknown[] = [];
      for (let i = 0; i < item.length; i++)
        items.push(child(String(i), `${path}[${i}]`, schema[0]));
      if (keys.length !== items.length + 1) invalid(path);
      return items;
    }
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) invalid(path);
    const name = (key: string) => (path === "input" ? key : `${path}.${key}`);
    for (const key of keys)
      if (!Object.hasOwn(schema, key))
        invalid(typeof key === "string" ? name(key) : path);
    const record: Record<string, unknown> = {};
    for (const [key, rule] of Object.entries(schema))
      record[key] = child(key, name(key), rule);
    return record;
  }
  try {
    const input = read(shape, value, "input") as ReviewGateInput;
    const [first, second] = input.reviews;
    if (!first || !second || input.reviews.length !== 2) invalid("reviews");
    if (first.reviewer === second.reviewer) invalid("reviews[1].reviewer");
    const pushedAt = Date.parse(input.pushedAt);
    for (const [i, review] of input.reviews.entries()) {
      const { status, reviewedHead, reviewedAt } = review;
      const path = `reviews[${i}]`;
      const absent = status === "none";
      const min = reviewedHead === input.prHead ? pushedAt : -Infinity;
      const at = reviewedAt === null ? Infinity : Date.parse(reviewedAt);
      if ((reviewedHead === null) !== absent) invalid(`${path}.reviewedHead`);
      if ((reviewedAt === null) !== absent || at < min)
        invalid(`${path}.reviewedAt`);
    }
    if (first.reviewer === "coderabbit") input.reviews.reverse();
    return input;
  } catch (error) {
    return error instanceof Error ? error.message : "input";
  }
}
export function validateReviewGateInput(value: unknown): string | null {
  const input = readInput(value);
  return typeof input === "string" ? input : null;
}

export function decide(value: unknown) {
  const input = readInput(value);
  const head = typeof input === "string" ? null : input.prHead;
  function result<R extends string>(reason: R, detail: string) {
    const state = reason === "pass" ? "success" : "failure";
    return { state, head, reason, description: detail.slice(0, 140) } as const;
  }
  if (typeof input === "string") return result("invalid", `invalid ${input}`);
  const { guard, reviews, history, unresolvedThreads } = input;
  if (unresolvedThreads) return result("open_threads", "open threads");
  if (guard.mainRed) return result("main_red", "main CI is red");
  let block = -Infinity;
  let checkedThrough = -Infinity;
  let exactPass = -Infinity;
  let fullPass = -Infinity;
  for (const row of history) {
    const at = Date.parse(row.at);
    const exactSol = row.head === head && row.kind === "sol";
    if (row.p1 > 0 || (exactSol && row.verdict !== "PASS"))
      block = Math.max(block, at);
    if (row.kind !== "sol" || row.verdict !== "PASS" || row.p1 !== 0) continue;
    checkedThrough = Math.max(checkedThrough, at);
    if (!exactSol) continue;
    exactPass = Math.max(exactPass, at);
    if (row.scope === "full") fullPass = Math.max(fullPass, at);
  }
  if (block > -Infinity && exactPass <= block)
    return result("sol_blocked", "Sol blocked");
  const securityPass = guard.securitySolPass && exactPass > block;
  if (guard.securityPathNeedsSol && !securityPass)
    return result("security", "security path needs Sol");
  const pushedAt = Date.parse(input.pushedAt);
  const codex = input.codexFindings;
  const routes: string[] = [];
  for (const review of reviews) {
    const { reviewer, status, reviewedHead, quotaAt, findingAts } = review;
    if (findingAts.some((time) => Date.parse(time) >= checkedThrough))
      return result("findings", `unchecked ${reviewer} findings`);
    const missing = codex === "findings_resolved" && !findingAts.length;
    if (reviewer === "codex" && (codex === "unresolved" || missing))
      return result("findings", "incomplete codex findings");
    if (status === "completed" && reviewedHead === head) {
      routes.push(reviewer);
      continue;
    }
    const overQuota = quotaAt !== null && Date.parse(quotaAt) >= pushedAt;
    if (!overQuota && Date.parse(input.now) - pushedAt < 600_000)
      return result("waiting", `waiting for ${reviewer}`);
    const route = `${reviewer} ${overQuota ? "quota" : "timeout"}`;
    if (fullPass <= block) return result("sol_needed", `Sol needed: ${route}`);
    routes.push(`sol stand-in: ${route}`);
  }
  return result("pass", routes.join("; "));
}
