import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { FileCapturePort } from "../../core/catalog/index.ts";
import { refuse } from "../../core/trust/index.ts";

/** Each read closes its descriptor before returning immutable captured bytes. */
export const nodeFileCapture: FileCapturePort = {
  open(rootPath) {
    const root = realpathSync(rootPath);
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
          const descriptor = openSync(path, "r");
          let data: Buffer;
          try {
            const opened = fstatSync(descriptor);
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
