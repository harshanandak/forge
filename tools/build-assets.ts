import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { writeGenerated } from "./gen/write.ts";

const root = resolve(import.meta.dirname, "..");
function copyJson(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) copyJson(path);
    else if (entry.name.endsWith(".json"))
      writeGenerated(
        join(root, "dist", relative(root, path)),
        readFileSync(path, "utf8"),
      );
  }
}
copyJson(join(root, "src"));
copyJson(join(root, "schemas"));
