/** Shipped blocks are opt-in sources; registration never enables or admits one. */
export const firstPartyBlocks: Readonly<Record<string, URL>> = {
  "forge/github-accounts": new URL(
    "../blocks/github-accounts/",
    import.meta.url,
  ),
  "forge/memory": new URL("../blocks/memory/", import.meta.url),
  "forge/work": new URL("../blocks/work/", import.meta.url),
};
