// Placeholder: the claim server lands in the next commit. Every route answers 501 until then.
const notBuilt = (): Response =>
  Response.json(
    {
      ok: false,
      error: {
        code: "UNKNOWN_COMMAND",
        message: "The claim server is not built yet",
        retry: "never",
      },
    },
    { status: 501 },
  );

export class Project {
  fetch(): Response {
    return notBuilt();
  }
}

export default {
  fetch: notBuilt,
};
