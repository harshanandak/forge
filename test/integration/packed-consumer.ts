/**
 * The npm install of the packed tarball. `bun run test:pack` packs and installs once, then runs
 * every packed journey against that one install; a packed suite never packs or installs itself.
 */
import { requireJourneyEnv } from "./journey-env.ts";
export function packedConsumer(): string {
  return requireJourneyEnv(
    "FORGE_PACKED_CONSUMER",
    "packed journeys run against the pack smoke's install: bun run test:pack",
  );
}
