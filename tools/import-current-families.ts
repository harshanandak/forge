const namespace = "forge/work";
const importedKeys: Record<string, RegExp> = {
  issue: /^issue:[^:]+$/,
  comment: /^comment:[^:]+:[1-9][0-9]*$/,
  link: /^link:[^:]+:[1-9][0-9]*$/,
  landing: /^landing:work-[0-9]+:[1-9][0-9]*$/,
  reopen: /^reopen:work-[0-9]+:[1-9][0-9]*$/,
  attempt: /^attempt:work-[0-9]+:attempt-[1-9][0-9]*$/,
  evidence: /^evidence:attempt:work-[0-9]+:attempt-[1-9][0-9]*:[1-9][0-9]*$/,
  cleanup: /^cleanup:work-[0-9]+$/,
  selection: /^selection:work-[0-9]+$/,
  slots: /^slots:work-[0-9]+$/,
  allocation: /^allocation:(?:issue:work-|(?:comment|link):[^:]+:)$/,
};
function matchesKey(
  patterns: Record<string, RegExp>,
  ns: string,
  key: string,
): boolean {
  const shape = key.split(":")[0]!;
  return (
    ns === namespace &&
    Object.hasOwn(patterns, shape) &&
    patterns[shape]?.test(key) === true &&
    !/[\p{Cc}\p{Cf}]/u.test(key) &&
    (shape === "bound-lane" || !/\s/u.test(key))
  );
}
export const ordinaryKey = (ns: string, key: string): boolean =>
  matchesKey(importedKeys, ns, key);

const localKeys: Record<string, RegExp> = {
  autopilot: /^autopilot:(?:global|work-[0-9]+)$/,
  "autopilot-ask": /^autopilot-ask:work-[0-9]+$/,
  "autopilot-clock": /^autopilot-clock:work-[0-9]+$/,
  "autopilot-event": /^autopilot-event:work-[0-9]+:[1-9][0-9]*$/,
  "autopilot-merge": /^autopilot-merge:work-[0-9]+$/,
  participant: /^participant:work-[0-9]+:[1-9][0-9]*$/,
  note: /^note:attempt:work-[0-9]+:attempt-[1-9][0-9]*:[1-9][0-9]*$/,
  "bound-lane": /^bound-lane:\[.*\]:work-[0-9]+$/,
};
export const leftBehindShapes = Object.keys(localKeys).map(
  (family) => `${family}:*`,
);
export function leftBehindKey(ns: string, key: string): boolean {
  if (!matchesKey(localKeys, ns, key)) return false;
  if (!key.startsWith("bound-lane:")) return true;
  try {
    const spelling = key.slice(11, key.lastIndexOf(":")),
      tuple: unknown = JSON.parse(spelling);
    return (
      Array.isArray(tuple) &&
      tuple.length === 3 &&
      tuple.every(
        (part) => typeof part === "string" && !/[\p{Cc}\p{Cf}]/u.test(part),
      ) &&
      JSON.stringify(tuple) === spelling
    );
  } catch {
    return false;
  }
}
export const classifiedFamily = (family: string): boolean =>
  Object.hasOwn(importedKeys, family) !== Object.hasOwn(localKeys, family);
