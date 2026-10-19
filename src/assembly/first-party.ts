/** Shipped blocks are opt-in sources; registration never enables or admits one. */
export const firstPartyBlocks: Readonly<Record<string, URL>> = {
  "forge/memory": new URL("../blocks/memory/", import.meta.url),
};
