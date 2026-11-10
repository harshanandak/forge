import type { Side } from "./speed-compare.ts";

export interface SpeedSample {
  readonly side: Side;
  readonly position: number;
  readonly ms: number;
}

export function recordSpeedSample(
  samples: SpeedSample[],
  side: Side,
  ms: number,
): void {
  samples.push({ side, position: samples.length + 1, ms });
}
