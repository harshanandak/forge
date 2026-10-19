/** Shipped blocks are opt-in sources; registration never enables or admits one. */
export const firstPartyBlocks: Readonly<Record<string, URL>> = {
  "forge/check": new URL("../blocks/check/", import.meta.url),
  "forge/pr": new URL("../blocks/pr/", import.meta.url),
  "forge/git": new URL("../blocks/git/", import.meta.url),
  "forge/memory": new URL("../blocks/memory/", import.meta.url),
  "forge/work": new URL("../blocks/work/", import.meta.url),
};
