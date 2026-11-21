import manifest from "../../../package.json" with { type: "json" };

const packageScripts: Record<string, string> = manifest.scripts;
export type Matrix = Record<string, unknown> & {
  include?: Record<string, unknown>[];
};

export function runsPackedJourney(
  run: string,
  seen = new Set<string>(),
): boolean {
  if (
    /\btools[\\/](?:pack-smoke[\\/]run\.ts|release[\\/]journeys\.mjs)(?=$|[\s"';&|)])/i.test(
      run,
    )
  )
    return true;
  for (const [, runScript, testScript] of run.matchAll(
    /\b(?:(?:bun|npm|pnpm|yarn)\s+run(?:-script)?\s+["']?([\w:-]+)|(?:npm|pnpm|yarn)\s+(test))(?=$|[\s"';&|)])/g,
  )) {
    const script = (runScript ?? testScript)!;
    if (seen.has(script) || !Object.hasOwn(packageScripts, script)) continue;
    seen.add(script);
    if (runsPackedJourney(packageScripts[script]!, seen)) return true;
  }
  return false;
}

function matrixValues(matrix: Matrix, reference: string): string[] {
  const [key, ...path] = reference.match(/[\w-]+/g) ?? [];
  if (!key) return [];
  const axis = matrix[key];
  const values: unknown[] = [
    ...(Array.isArray(axis) ? (axis as unknown[]) : []),
    ...(matrix.include ?? []).map((row) => row[key]),
  ];
  return values
    .map((value) =>
      path.reduce<unknown>(
        (object, field) =>
          object && typeof object === "object"
            ? (object as Record<string, unknown>)[field]
            : undefined,
        value,
      ),
    )
    .filter((value): value is string => typeof value === "string");
}

export function stepCommands(run: string, matrix?: Matrix): string[] {
  if (!matrix) return [run];
  let expanded = [run];
  for (const expression of new Set(run.match(/\$\{\{.*?\}\}/gs))) {
    const values = new Set(
      [
        ...expression.matchAll(/\bmatrix((?:\.[\w-]+|\[['"][\w-]+['"]\])+)/g),
      ].flatMap((match) => matrixValues(matrix, match[1]!)),
    );
    if (values.size > 0)
      expanded = expanded.flatMap((command) =>
        Array.from(values, (value) =>
          command.replaceAll(expression, () => value),
        ),
      );
  }
  return [run, ...expanded];
}
