// Bun test preload: generate src/generated before any test file is loaded, so `bun test` works from a
// clean checkout without a separate gen step.
import { write } from "./types.ts";

write();
