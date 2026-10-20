/**
 * Shipped blocks are opt-in sources; registration never enables one. Once enabled they run
 * without admission or grants: installing the package is the trust step. A path or package
 * copy of the same bytes, or with the same id, still needs human admission.
 */
export const firstPartyBlocks: Readonly<Record<string, URL>> = {
  "forge/check": new URL("../blocks/check/", import.meta.url),
  "forge/memory": new URL("../blocks/memory/", import.meta.url),
  "forge/work": new URL("../blocks/work/", import.meta.url),
};
