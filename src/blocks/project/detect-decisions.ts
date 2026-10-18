// Detector for the project's decision records: where they live, whether each record is its own
// file or one log, and how records are numbered, so new records follow the project's own format.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import { detected } from "./observation.ts";

const AREA = "decisions";

const FOLDERS = [
  "docs/adr",
  "docs/adrs",
  "docs/decisions",
  "docs/architecture/decisions",
  "doc/adr",
  "doc/decisions",
  "architecture/decisions",
  "adr",
  "adrs",
  "decisions",
];

const LOGS = [
  "DECISIONS.md",
  "decisions.md",
  "docs/DECISIONS.md",
  "docs/decisions.md",
  "docs/decision-log.md",
  "docs/decisions/log.md",
];

/** A record id as the project writes it: a prefix, the digits, and how many digits it pads to. */
interface IdShape {
  readonly prefix: string;
  readonly width: number;
  readonly highest: number;
  readonly count: number;
}

function shapeOf(
  ids: ReadonlyArray<{ prefix: string; digits: string }>,
): IdShape | undefined {
  if (ids.length === 0) return undefined;
  const first = ids[0] as { prefix: string; digits: string };
  const same = ids.filter((id) => id.prefix === first.prefix);
  const numbers = same.map((id) => Number(id.digits));
  return {
    prefix: first.prefix,
    width: Math.max(...same.map((id) => id.digits.length)),
    highest: Math.max(...numbers),
    count: same.length,
  };
}

function pattern(shape: IdShape): string {
  return `${shape.prefix}${"N".repeat(shape.width)}`;
}

export function detectDecisions(files: ProjectFiles): DetectionObservation[] {
  const out: DetectionObservation[] = [];

  for (const folder of FOLDERS) {
    if (!files.isDirectory(folder)) continue;
    const records = files
      .list(folder)
      .filter((name) => /\.(?:md|markdown|adoc)$/i.test(name));
    const ids = records.flatMap((name) => {
      const match = /^((?:[A-Za-z]+-)?)(\d{2,5})[-_.]/.exec(name);
      return match === null
        ? []
        : [{ prefix: match[1] as string, digits: match[2] as string }];
    });
    const shape = shapeOf(ids);
    if (shape === undefined && records.length === 0) continue;
    out.push(
      detected(
        AREA,
        ["records"],
        {
          layout: "file-per-record",
          path: folder,
          count: records.length,
          ...(shape === undefined
            ? {}
            : { idPattern: pattern(shape), highest: shape.highest }),
        },
        { file: folder },
      ),
    );
    return out;
  }

  for (const log of LOGS) {
    const text = files.read(log);
    if (text === undefined) continue;
    const ids = [
      ...text.matchAll(/^#{1,6}\s*\[?((?:[A-Za-z]+-)?)(\d{1,5})\b/gm),
    ].map((match) => ({
      prefix: match[1] as string,
      digits: match[2] as string,
    }));
    const shape = shapeOf(ids);
    out.push(
      detected(
        AREA,
        ["records"],
        {
          layout: "single-file",
          path: log,
          count: shape?.count ?? 0,
          ...(shape === undefined
            ? {}
            : { idPattern: pattern(shape), highest: shape.highest }),
        },
        { file: log },
      ),
    );
    return out;
  }
  return out;
}
