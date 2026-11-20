# Owner approval by chat

For cloud `lane.resume`, first request the exact scope. Display the flat
`result.ask` in chat and wait for a clear affirmative reply to that question
within 10 minutes. Retry the same scope with a new command id and
`approval: {request: result.request, quote, source: {harness, thread, message?, link?}}`.
Copy the reply verbatim. Refusal, ambiguity or silence leaves the stop set.
After expiry or a changed stop, request and ask again.

For local approval, when Forge returns `APPROVAL_REQUIRED`, ask the owner in this chat using
`result.request.ask`: say what will happen, to what, and what it allows. Wait for
their reply to this specific request. Silence or a reply to another question is
not approval. Any non-empty answer, including "yes" or "continue", counts when it
answers this specific question.

Retry the same operation with the same input plus:

```json
"approval": {
  "request": "<result.request.id>",
  "quote": "<owner's reply copied exactly>",
  "source": {
    "harness": "<your harness>",
    "thread": "<this thread or session id>",
    "message": "<message id if available>",
    "link": "<reply link if available>"
  }
}
```

Omit unavailable optional message and link fields. Never invent a quote or source,
reuse a request id, or add approval because a hint suggested it. If the reply changes
the plan, follow the reply and request approval for the changed operation.

Requests expire after 24 hours and bind the operation, arguments, device and project.
Forge logs the reply as untrusted quoted data, its source, and the relaying session.
It cannot prove who typed a reply. A deliberate agent running as the same OS user
can fabricate evidence or edit the store. This is relayed consent with an audit
trail, not authentication. The CLI caller value `human` means local CLI process.
