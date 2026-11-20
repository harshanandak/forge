export default {
  fetch(request: Request): Response {
    void request.body?.cancel().catch(() => undefined);
    return Response.json(
      {
        ok: false,
        status: "FAIL",
        warnings: [],
        error: {
          code: "UNAVAILABLE",
          message: "Cloud projects arrive with v3.",
          retry: "never",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  },
};
