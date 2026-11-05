# Account reply routing

Before the first commit or push, run `forge accounts plan --json`, relay `result.ask` unchanged and wait for the owner's reply.

- Only a clear yes or a named account permits `forge accounts use --input`.
- Only a clear no permits `forge accounts decline --input`.
- For an unclear reply, ask again and call neither operation.

For either operation, pass `approval: {quote, source}` in the input, with the owner's verbatim reply and its chat source. Forge records this evidence without interpreting the reply. A bound or explicitly declined result permits continuing.
