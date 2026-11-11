export const BODY_LIMIT_BYTES = 8192;
class BodyTooLarge extends Error {}

export async function boundedBody(
  request: { headers: Pick<Headers, "get">; body: Request["body"] },
  max: number,
): Promise<Blob> {
  if (Number(request.headers.get("Content-Length")) > max) {
    void request.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge();
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader)
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid body chunk");
      bytes += value.byteLength;
      if (bytes > max) {
        void reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  return new Blob(chunks);
}

export async function boundedOAuthRequest(request: Request) {
  try {
    return new Request(request, {
      body: await boundedBody(request, BODY_LIMIT_BYTES),
    });
  } catch (error) {
    if (!(error instanceof BodyTooLarge)) throw error;
    return Response.json(
      {
        error: "invalid_request",
        error_description: `Request body exceeds ${BODY_LIMIT_BYTES} bytes`,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
