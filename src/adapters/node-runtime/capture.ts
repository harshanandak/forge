import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  realpathSync,
  statSync,
  constants,
} from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { FileCapturePort } from "../../core/catalog/index.ts";
import { refuse } from "../../core/trust/index.ts";

/**
 * Each read closes its descriptor before returning immutable captured bytes.
 *
 * Paths resolve with one native call each instead of one `lstat` per path component in JavaScript:
 * a block read resolves four paths per file and a command reads over a hundred files. The native
 * resolver can be unusable (musl without /proc fails every call), so the first root decides: if the
 * native resolver fails but the JavaScript one succeeds, this capture port uses the JavaScript one
 * for the root and every file. Root and file paths always come from the same resolver, so the
 * containment comparisons below stay like with like. `nativeRealpath` is a seam for tests.
 */
export function createNodeFileCapture(
  beforeOpen?: () => void,
  nativeRealpath: (path: string) => string = realpathSync.native,
): FileCapturePort {
  let chosen: ((path: string) => string) | undefined;
  return {
    open(rootPath) {
      let root: string;
      if (chosen === undefined) {
        try {
          root = nativeRealpath(rootPath);
          chosen = nativeRealpath;
        } catch {
          // A root that does not exist fails here too, with the JavaScript resolver's own error.
          root = realpathSync(rootPath);
          chosen = realpathSync;
        }
      } else root = chosen(rootPath);
      const realpath = chosen;
      const rootIdentity = statSync(root, { bigint: true });
      if (!rootIdentity.isDirectory())
        refuse("INPUT_INVALID", "capture root must be a directory");
      return {
        ownership: "borrowed",
        value: {
          read(name, maxBytes) {
            const path = realpath(resolve(root, name));
            const rel = relative(root, path);
            if (
              isAbsolute(name) ||
              name.split(/[\\/]/).includes("..") ||
              rel === ".." ||
              rel.startsWith(`..${sep}`) ||
              isAbsolute(rel)
            )
              refuse("INPUT_INVALID", "capture path leaves its root");
            const stat = statSync(path, { bigint: true });
            if (!stat.isFile())
              refuse("INPUT_INVALID", "capture requires regular files");
            const bytes = stat.size;
            if (bytes > BigInt(maxBytes))
              refuse("LIMIT_EXCEEDED", `capture exceeds maxBytes ${maxBytes}`);
            beforeOpen?.();
            const descriptor = openSync(
              path,
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            );
            let data: Buffer;
            try {
              const opened = fstatSync(descriptor, { bigint: true });
              // Validate the opened identity before reading: textual containment alone races renames.
              const openedPath = realpath(path);
              const openedRelative = relative(root, openedPath);
              const currentRoot = statSync(root, { bigint: true });
              const currentFile = statSync(openedPath, { bigint: true });
              if (
                realpath(root) !== root ||
                currentRoot.dev !== rootIdentity.dev ||
                currentRoot.ino !== rootIdentity.ino ||
                openedRelative === ".." ||
                openedRelative.startsWith(`..${sep}`) ||
                isAbsolute(openedRelative) ||
                currentFile.dev !== opened.dev ||
                currentFile.ino !== opened.ino
              )
                refuse(
                  "INPUT_CONFLICT",
                  "capture root or file changed during open",
                );
              if (
                !opened.isFile() ||
                opened.dev !== stat.dev ||
                opened.ino !== stat.ino ||
                opened.size !== stat.size
              )
                refuse("INPUT_CONFLICT", "file changed during capture");
              data = Buffer.alloc(Number(stat.size));
              let offset = 0;
              while (offset < data.length) {
                const count = readSync(
                  descriptor,
                  data,
                  offset,
                  data.length - offset,
                  offset,
                );
                if (count === 0)
                  refuse("INPUT_CONFLICT", "file changed during capture");
                offset += count;
              }
              if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0)
                refuse("INPUT_CONFLICT", "file grew during capture");
            } finally {
              closeSync(descriptor);
            }
            return data;
          },
        },
      };
    },
  };
}

export const nodeFileCapture: FileCapturePort = createNodeFileCapture();
