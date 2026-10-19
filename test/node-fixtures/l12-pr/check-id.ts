export function checkNodeId(
  check: {
    readonly name: string;
    readonly headSha: string;
    readonly appId: number | null;
  },
  index: number,
): string {
  return `${check.appId === null ? "S" : "C"}:${check.name}:${check.headSha}:${index}`;
}
