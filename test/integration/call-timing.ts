const requested = Number(process.env.FORGE_821_REPEAT ?? 1);
export const timingRepeats =
  Number.isSafeInteger(requested) && requested > 0 ? requested : 1;

type Fields = Readonly<Record<string, unknown>>;

function report(fields: Fields, started: number): void {
  console.log(
    `forge-821-timing ${JSON.stringify({
      ...fields,
      platform: process.platform,
      runtime: process.versions.bun
        ? `bun ${process.versions.bun}`
        : `node ${process.version}`,
      wallMs: performance.now() - started,
    })}`,
  );
}

export function timed<T>(fields: Fields, action: () => T): T {
  const started = performance.now();
  try {
    return action();
  } finally {
    report(fields, started);
  }
}

export async function timedAsync<T>(
  fields: Fields,
  action: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    report(fields, started);
  }
}
