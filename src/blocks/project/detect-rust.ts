// Detector for Rust projects, read from Cargo.toml, Cargo.lock and the toolchain pin.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import { detected, firstExisting } from "./observation.ts";
import { hasTomlTable, tomlString, tomlTable } from "./toml.ts";

const AREA = "rust";

function stringList(lines: readonly string[], key: string): string[] {
  const text = lines.join("\n");
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(
    text,
  );
  if (match === null) return [];
  return [...(match[1] as string).matchAll(/"([^"]+)"|'([^']+)'/g)].map(
    (entry) => (entry[1] ?? entry[2]) as string,
  );
}

export function detectRust(files: ProjectFiles): DetectionObservation[] {
  const cargo = files.read("Cargo.toml");
  if (cargo === undefined) return [];

  const out: DetectionObservation[] = [
    detected(AREA, ["present"], true, { file: "Cargo.toml" }),
  ];
  const name = tomlString(cargo, "package", "name");
  if (name !== undefined) {
    const edition = tomlString(cargo, "package", "edition");
    out.push(
      detected(
        AREA,
        ["package"],
        { name, ...(edition === undefined ? {} : { edition }) },
        {
          file: "Cargo.toml",
        },
      ),
    );
  }
  if (hasTomlTable(cargo, "workspace")) {
    out.push(
      detected(
        AREA,
        ["workspace"],
        { members: stringList(tomlTable(cargo, "workspace"), "members") },
        { file: "Cargo.toml" },
      ),
    );
  }
  if (files.exists("Cargo.lock")) {
    out.push(detected(AREA, ["lockfile"], true, { file: "Cargo.lock" }));
  }
  const toolchain = firstExisting(files, [
    "rust-toolchain.toml",
    "rust-toolchain",
  ]);
  if (toolchain !== undefined) {
    const text = files.read(toolchain) ?? "";
    const channel =
      tomlString(text, "toolchain", "channel") ??
      (toolchain === "rust-toolchain"
        ? text.trim().split(/\r?\n/)[0]
        : undefined);
    if (channel !== undefined && channel !== "") {
      out.push(detected(AREA, ["toolchain"], channel, { file: toolchain }));
    }
  }
  return out;
}
