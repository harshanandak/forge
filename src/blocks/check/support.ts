import { createHash, randomUUID } from "node:crypto";
import type { CryptoService } from "./services.ts";
export const checkCrypto: CryptoService = {
  sha256: (text) => createHash("sha256").update(text).digest("hex"),
  randomUUID,
};
