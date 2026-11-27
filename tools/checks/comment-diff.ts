import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { gitExecutable } from "../git-executable.ts";

const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const OBJECT_ID = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
const BATCH_HEADER = new RegExp(`^(${OBJECT_ID}) ([a-z]+)(?: ([0-9]+))?$`);
const TREE_RECORD = new RegExp(`^(\\S+) (\\S+) (${OBJECT_ID})$`);

export interface CommentSnapshot {
  readonly head: string;
  readonly files: ReadonlyMap<
    string,
    { readonly text: string; readonly added: ReadonlySet<number> }
  >;
  currentHead(): string;
}
export function parseCatFileBatch(
  output: Buffer,
  oids: readonly string[],
): Buffer[] {
  const bodies: Buffer[] = [];
  let offset = 0;
  for (const oid of oids) {
    const end = output.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete batch blob output");
    const header = output.subarray(offset, end).toString("latin1");
    const found = BATCH_HEADER.exec(header);
    const id = found?.[1];
    const kind = found?.[2];
    const rawSize = found?.[3];
    if (!found || id !== oid) throw new Error("Incomplete batch blob output");
    if (kind !== "blob") throw new Error("Incomplete batch blob content");
    if (rawSize === undefined) throw new Error("Incomplete batch blob output");
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES)
      throw new Error("Oversized batch blob content");
    const bodyEnd = end + 1 + size;
    if (bodyEnd + 1 > output.length || output[bodyEnd] !== 10)
      throw new Error("Incomplete batch blob output");
    const body = output.subarray(end + 1, bodyEnd);
    if (body.length !== size) throw new Error("Incomplete batch blob output");
    bodies.push(body);
    offset = bodyEnd + 1;
  }
  if (offset !== output.length) throw new Error("Incomplete batch blob output");
  return bodies;
}
export function parseLsTree(output: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const file = tab < 0 ? "" : record.slice(tab + 1);
    const match = TREE_RECORD.exec(tab < 0 ? "" : record.slice(0, tab));
    const mode = match?.[1];
    const oid = match?.[3];
    if (
      !match ||
      (mode !== "100644" && mode !== "100755") ||
      match[2] !== "blob" ||
      !file ||
      !oid ||
      blobs.has(file)
    )
      throw new Error("Incomplete committed blob listing");
    blobs.set(file, oid);
  }
  return blobs;
}
export function resolveBlobIds(
  files: readonly string[],
  blobs: ReadonlyMap<string, string>,
): string[] {
  if (blobs.size !== files.length)
    throw new Error("Incomplete committed blob listing");
  return files.map((file) => {
    const oid = blobs.get(file);
    if (oid === undefined) throw new Error("Incomplete committed blob listing");
    return oid;
  });
}
export function readCommittedTexts(
  root: string,
  head: string,
  files: readonly string[],
): Map<string, string> {
  const texts = new Map<string, string>();
  if (!files.length) return texts;
  const executable = gitExecutable();
  const git = (...args: string[]): string =>
    execFileSync(
      executable,
      ["--literal-pathspecs", "-c", "diff.interHunkContext=0", ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        stdio: "pipe",
      },
    );
  const blobs = parseLsTree(git("ls-tree", "-r", "-z", head, "--", ...files));
  const oids = resolveBlobIds(files, blobs);
  const batch = spawnSync(
    executable,
    [
      "--literal-pathspecs",
      "-c",
      "diff.interHunkContext=0",
      "cat-file",
      "--batch",
    ],
    {
      cwd: root,
      input: oids.map((oid) => `${oid}\n`).join(""),
      timeout: 15_000,
      maxBuffer: oids.length * (MAX_BLOB_BYTES + 64) + 1024,
      windowsHide: true,
      stdio: "pipe",
    },
  );
  if (batch.error) throw batch.error;
  if (batch.status !== 0)
    throw new Error(
      batch.stderr.length
        ? batch.stderr.toString("utf8")
        : "Incomplete committed blob read",
    );
  const output: unknown = batch.stdout;
  if (!Buffer.isBuffer(output))
    throw new Error("Incomplete committed blob read");
  const bodies = parseCatFileBatch(output, oids);
  for (const [index, file] of files.entries()) {
    const body = bodies[index];
    if (body === undefined) throw new Error("Incomplete batch blob output");
    texts.set(file, body.toString("utf8"));
  }
  return texts;
}
export function commentDiff(
  root: string,
  baseRef: string,
  roots: readonly string[] = ["."],
): CommentSnapshot {
  const executable = gitExecutable();
  const git = (...args: string[]): string =>
    execFileSync(
      executable,
      ["--literal-pathspecs", "-c", "diff.interHunkContext=0", ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        stdio: "pipe",
      },
    );
  const currentHead = (): string =>
    git("rev-parse", "--verify", "HEAD^{commit}").trim();
  const head = currentHead();
  const base = git(
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`,
  ).trim();
  const mergeBase = git("merge-base", base, head).trim();
  const covered = (file: string): boolean =>
    /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) &&
    roots.some(
      (root) => root === "." || file.startsWith(`${root.replace(/\/$/, "")}/`),
    );
  const names = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--ignore-submodules=none",
    "--name-status",
    "-z",
    "--no-color",
    "--no-renames",
    "--find-renames=50%",
    "-l0",
    "--diff-filter=ACMRTUXB",
    mergeBase,
    head,
  ).split("\0");
  const selected: { file: string; previous: string; status: string }[] = [];
  while (names[0]) {
    const status = names.shift()!;
    const previous = names.shift();
    const file = /^[RC]/.test(status) ? names.shift() : previous;
    if (!file || !previous) throw new Error("Incomplete changed-file list");
    if (!/^(?:[AMT]|[RC]\d+)$/.test(status))
      throw new Error(`Unsupported Git change: ${status}`);
    if (!covered(file)) continue;
    selected.push({ file, previous, status });
  }
  const texts = readCommittedTexts(
    root,
    head,
    selected.map((entry) => entry.file),
  );
  const files = new Map<string, { text: string; added: ReadonlySet<number> }>();
  for (const entry of selected) {
    const text = texts.get(entry.file);
    if (text === undefined)
      throw new Error("Incomplete committed blob listing");
    const added = new Set<number>();
    if (
      /^[ACT]/.test(entry.status) ||
      (entry.status.startsWith("R") && !covered(entry.previous))
    ) {
      for (let line = 1; line <= text.split("\n").length; line++)
        added.add(line);
    } else {
      const diff = git(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--text",
        "--word-diff=none",
        "--output-indicator-new=+",
        "--output-indicator-old=-",
        "--output-indicator-context= ",
        "--no-renames",
        "--diff-algorithm=myers",
        "--no-indent-heuristic",
        "--inter-hunk-context=0",
        "-U0",
        `${mergeBase}:${entry.previous}`,
        `${head}:${entry.file}`,
      );
      let line: number | undefined;
      for (const part of diff.split("\n")) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(part);
        if (hunk) line = Number(hunk[1]);
        else if (line !== undefined && part.startsWith("+")) added.add(line++);
        else if (line !== undefined && part.startsWith(" ")) line++;
      }
    }
    files.set(entry.file, { text, added });
  }
  return { head, files, currentHead };
}
