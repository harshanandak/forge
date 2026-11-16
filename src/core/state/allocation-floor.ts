/** Invalid historical values reserve nothing; live callers decide whether to refuse them. */
export function allocationFloorNumber(
  value: unknown,
  prefix: string,
): number | undefined {
  const floor = value as { prefix?: unknown; number?: unknown } | null;
  if (
    typeof floor !== "object" ||
    floor === null ||
    Object.keys(floor).length !== 2 ||
    floor.prefix !== prefix ||
    typeof floor.number !== "number" ||
    !Number.isSafeInteger(floor.number) ||
    floor.number < 0
  )
    return undefined;
  return floor.number;
}
