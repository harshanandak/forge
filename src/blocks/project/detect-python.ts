// Detector for Python projects: manifests, which dependency manager the project uses, the build
// backend and test runner it declares. Shape detection over the project's own files; it runs nothing.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import { detected, firstExisting } from "./observation.ts";
import { hasTomlTable, tomlString } from "./toml.ts";

const AREA = "python";

const MANIFESTS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "requirements.txt",
];

function requirementFiles(files: ProjectFiles): string[] {
  const extra = files
    .list("requirements")
    .filter((name) => name.endsWith(".txt"))
    .map((name) => `requirements/${name}`);
  const flat = files
    .list(".")
    .filter((name) => /^requirements[-_.][\w.-]*\.txt$/.test(name));
  return [...new Set([...flat, ...extra])].sort();
}

export function detectPython(files: ProjectFiles): DetectionObservation[] {
  const requirements = [
    ...(files.exists("requirements.txt") ? ["requirements.txt"] : []),
    ...requirementFiles(files),
  ];
  const primary = firstExisting(files, MANIFESTS) ?? requirements[0];
  if (primary === undefined) return [];

  const out: DetectionObservation[] = [
    detected(AREA, ["present"], true, { file: primary }),
  ];
  const pyproject = files.read("pyproject.toml") ?? "";

  // Dependency managers: each one the project shows evidence of, by name.
  const managers: Array<[string, string]> = [];
  if (files.exists("uv.lock")) managers.push(["uv", "uv.lock"]);
  else if (hasTomlTable(pyproject, "tool.uv"))
    managers.push(["uv", "pyproject.toml"]);
  if (files.exists("poetry.lock")) managers.push(["poetry", "poetry.lock"]);
  else if (hasTomlTable(pyproject, "tool.poetry"))
    managers.push(["poetry", "pyproject.toml"]);
  if (files.exists("pdm.lock")) managers.push(["pdm", "pdm.lock"]);
  else if (hasTomlTable(pyproject, "tool.pdm"))
    managers.push(["pdm", "pyproject.toml"]);
  if (files.exists("Pipfile.lock")) managers.push(["pipenv", "Pipfile.lock"]);
  else if (files.exists("Pipfile")) managers.push(["pipenv", "Pipfile"]);
  if (managers.length === 0 && requirements.length > 0) {
    managers.push(["pip", requirements[0] as string]);
  }
  for (const [name, file] of managers) {
    out.push(detected(AREA, ["packageManagers", name], {}, { file }));
  }

  const backend = tomlString(pyproject, "build-system", "build-backend");
  if (backend !== undefined) {
    out.push(
      detected(AREA, ["buildBackend"], backend, { file: "pyproject.toml" }),
    );
  }
  const required = tomlString(pyproject, "project", "requires-python");
  if (required !== undefined) {
    out.push(
      detected(AREA, ["requiresPython"], required, { file: "pyproject.toml" }),
    );
  }
  const pinned = files.read(".python-version")?.trim().split(/\r?\n/)[0];
  if (pinned !== undefined && pinned !== "") {
    out.push(
      detected(AREA, ["pinnedVersion"], pinned, { file: ".python-version" }),
    );
  }

  // Test runner: declared configuration first, then a declared dependency.
  const runnerFile = ((): string | undefined => {
    if (hasTomlTable(pyproject, "tool.pytest")) return "pyproject.toml";
    if (files.exists("pytest.ini")) return "pytest.ini";
    if (/^\s*\[pytest\]/m.test(files.read("tox.ini") ?? "")) return "tox.ini";
    if (/^\s*\[tool:pytest\]/m.test(files.read("setup.cfg") ?? ""))
      return "setup.cfg";
    const declared = [
      ...requirements,
      ...(pyproject === "" ? [] : ["pyproject.toml"]),
      ...(files.exists("Pipfile") ? ["Pipfile"] : []),
    ].find((file) =>
      /(^|[^\w-])pytest([^\w-]|$)/i.test(files.read(file) ?? ""),
    );
    return declared;
  })();
  if (runnerFile !== undefined) {
    out.push(
      detected(AREA, ["testRunners", "pytest"], {}, { file: runnerFile }),
    );
  }
  if (files.exists("tox.ini"))
    out.push(detected(AREA, ["taskRunners", "tox"], {}, { file: "tox.ini" }));
  if (files.exists("noxfile.py"))
    out.push(
      detected(AREA, ["taskRunners", "nox"], {}, { file: "noxfile.py" }),
    );

  return out;
}
