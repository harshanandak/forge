// Detector for Go projects, read from go.mod, go.work and the vendor folder.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import { detected } from "./observation.ts";

const AREA = "go";

export function detectGo(files: ProjectFiles): DetectionObservation[] {
  const mod = files.read("go.mod");
  const work = files.read("go.work");
  if (mod === undefined && work === undefined) return [];

  const out: DetectionObservation[] = [];
  if (mod !== undefined) {
    out.push(detected(AREA, ["present"], true, { file: "go.mod" }));
    const module = /^\s*module\s+(\S+)/m.exec(mod)?.[1];
    if (module !== undefined) {
      out.push(
        detected(AREA, ["module"], module.replace(/^"|"$/g, ""), {
          file: "go.mod",
        }),
      );
    }
    const version = /^\s*go\s+(\d[\w.]*)/m.exec(mod)?.[1];
    if (version !== undefined) {
      out.push(detected(AREA, ["version"], version, { file: "go.mod" }));
    }
    if (files.isDirectory("vendor")) {
      out.push(detected(AREA, ["vendored"], true, { file: "vendor" }));
    }
  }
  if (work !== undefined) {
    out.push(detected(AREA, ["workspace"], true, { file: "go.work" }));
    if (mod === undefined) {
      out.push(detected(AREA, ["present"], true, { file: "go.work" }));
    }
  }
  return out;
}
