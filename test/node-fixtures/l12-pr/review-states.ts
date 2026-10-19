export function ignoredReviews(head: string, now: number) {
  return [
    {
      id: "R0",
      author: "history",
      authorizing: true,
      state: "COMMENTED",
      headSha: "c".repeat(40),
      updatedAt: now - 20000,
    },
    ...["COMMENTED", "DISMISSED"].map((state) => ({
      id: `R-${state}`,
      author: `reviewer-${state}`,
      authorizing: true,
      state,
      headSha: head,
      updatedAt: now - 10000,
    })),
  ];
}
