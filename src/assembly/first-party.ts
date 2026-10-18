/** Shipped blocks are opt-in sources; registration never enables or admits one. */
export const firstPartyBlocks: Readonly<Record<string, URL>> = {
  "forge/work": new URL("../blocks/work/", import.meta.url),
};
