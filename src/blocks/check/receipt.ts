import entry from "./entry.cts";
import { checkCrypto } from "./support.ts";
import type { CheckReceipt } from "./types.ts";
import type { CryptoService } from "./services.ts";
const pure = entry as unknown as {
  canonical(value: unknown): string;
  digest(value: unknown, crypto: CryptoService): string;
  verify(
    value: unknown,
    expected: string,
    crypto: CryptoService,
  ): value is CheckReceipt;
};
export const canonical: (value: unknown) => string = (value) =>
  pure.canonical(value);
export const hash = (value: unknown): string => pure.digest(value, checkCrypto);
export function verifyReceipt(
  value: unknown,
  expected: string,
): value is CheckReceipt {
  return pure.verify(value, expected, checkCrypto);
}
