/**
 * The npm install of the packed tarball. `bun run test:pack` packs and installs once, then runs
 * every packed journey against that one install; a packed suite never packs or installs itself.
 */
export function packedConsumer(): string {
  const consumer = process.env.FORGE_PACKED_CONSUMER;
  if (!consumer)
    throw new Error(
      "packed journeys run against the pack smoke's install: bun run test:pack",
    );
  return consumer;
}
