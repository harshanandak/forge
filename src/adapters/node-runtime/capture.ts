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

/** Each read closes its descriptor before returning immutable captured bytes. */
export function createNodeFileCapture(
  beforeOpen?: () => void,
): FileCapturePort {
  return {
    open(rootPath) {
      const root = realpathSync(rootPath);
      const rootIdentity = statSync(root);
      if (!rootIdentity.isDirectory())
        refuse("INPUT_INVALID", "capture root must be a directory");
      return {
        ownership: "borrowed",
        value: {
          read(name, maxBytes) {
            const path = realpathSync(resolve(root, name));
            const rel = relative(root, path);
            if (
              isAbsolute(name) ||
              name.split(/[\\/]/).includes("..") ||
              rel === ".." ||
              rel.startsWith(`..${sep}`) ||
              isAbsolute(rel)
            )
              refuse("INPUT_INVALID", "capture path leaves its root");
            const stat = statSync(path);
            if (!stat.isFile())
              refuse("INPUT_INVALID", "capture requires regular files");
            const bytes = stat.size;
            if (bytes > maxBytes)
              refuse("LIMIT_EXCEEDED", `capture exceeds maxBytes ${maxBytes}`);
            beforeOpen?.();
            const descriptor = openSync(
              path,
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            );
            let data: Buffer;
            try {
              const opened = fstatSync(descriptor);
              // Validate the opened identity before reading: textual containment alone races renames.
              const openedPath = realpathSync(path);
              const openedRelative = relative(root, openedPath);
              const currentRoot = statSync(root);
              const currentFile = statSync(openedPath);
              if (
                realpathSync(root) !== root ||
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
              data = Buffer.alloc(stat.size);
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
