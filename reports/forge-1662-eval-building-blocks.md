Decisions needed: none. This is a research recommendation, not a release decision.

# Verdict in plain words

- Use a hibernating WebSocket for a connected agent. It avoids paying for a waiting connection while the server can sleep.
- Build a stored, numbered event log and reconnect from the last acknowledged number. A socket alone cannot recover missed answers.
- Build the ask record, validation, allowed-answerer list, handoff and answer audit in Forge. A notification service must not decide who can answer.
- Use Durable Object alarms for reminders, with a stored queue of due deliveries. A single alarm can wake the next due item.
- Use web push to reach the installed phone app. Send a stable notification tag per ask and person, then test replacement on both phones.
- Treat phone delivery and sound as best effort. Keep the actual question and answer in the server inbox so a missed push is recoverable.
- Use the existing OAuth identity as the starting point, then explicitly check assignment and handoff on every answer.
- Add Slack as a delivery adapter for teams, with signed requests and an explicit mapping to a verified Forge person.
- Consider MCP elicitation as an agent interface when the client supports it. Keep the durable mailbox independent of MCP.
- Borrow ideas from Board and HumanLayer, but keep Forge's own authority and state.
- Avoid running Novu, ntfy, Gotify or Nightmail as the core mailbox for this scope. They add infrastructure or do not satisfy the phone and identity requirements.
- Measure costs and real device behavior before promising free operation or one visible notification on both platforms.

# The recommended stack

1. Waiting: Durable Object WebSocket hibernation plus persisted event cursor and reconnect. Runner-up: HTTP long poll, simpler but a held request prevents hibernation and consumes duration.
2. Timers: Durable Object alarm plus persisted priority queue and per-person delivery attempts. Runner-up: Queues, which adds queue operations and a separate delivery mechanism; one alarm per object needs explicit multiplexing.
3. Phone: standards-based Web Push, VAPID, service worker and installed PWA. Cloudflare documents the `web-push` library in an Agents example; prove its exact runtime configuration in a pilot. Runner-up: ntfy, which needs an extra service/app and has iOS relay constraints.
4. Sign-in: existing Forge OAuth integration, with Forge-side authorization for named people, reassignment and audit. Runner-up: trust a notification reply identity, which does not by itself enforce Forge authorization.
5. Team delivery: Forge per-person inbox and a Slack adapter. Runner-up: Novu, which adds a separate notification platform. Validate Slack identity mapping and interaction signatures before accepting answers.

# Comparison table

Evidence is published documentation and source inspection, rung 2. No candidate was run. Needs listed are components directly supported, not a claim that a candidate alone satisfies an entire need. P = partial. Platform entries use provider terms rather than an open-source license. Dates and stars below are GitHub API last-push snapshots on 2026-11-21; a push is not a release or a maturity guarantee. Workers yes means the described building block can run there, not that its whole hosted product does.

| Candidate | License; last push/release | Workers | Free allocation that matters | Needs | Verdict and reason |
|---|---|---|---|---|---|
| 1. Hibernating WebSocket | Cloudflare service terms; release date not applicable | yes | DO 100,000 requests/day, 13,000 GB-s/day [D] | N2 P, N5 P, N6 P | use it: idle connections can hibernate; Forge must persist cursors and reconnect. |
| 2. HTTP long poll | Cloudflare service terms; release date not applicable | yes | [D], held requests accrue duration | N2 P, N5 P, N6 P | copy the pattern: useful fallback; not the preferred always-waiting path. |
| 3. Server-sent events | Web standard, platform terms; release date not applicable | yes | Worker 100,000 requests/day [W]; an active DO response stream prevents hibernation [L] | N2 P, N5 P, N6 P | do not use: a live stream still needs reconnection and can hold the object active. |
| 4. Workflows waitForEvent | Cloudflare service terms; release date not applicable | yes | 100,000 executions/day, 100 running concurrently; waiting instances do not count [WF] | N2 P, N5 P, N6 P | copy the pattern: durable waits are useful for larger workflows, but do not replace the answer inbox or agent reconnect. |
| 5. Queues or DO alarms | Cloudflare service terms; release date not applicable | yes | Queues 10,000 operations/day; alarms count against DO request and write limits [Q] [D] | N4 P, N5 P, N6 P | use it: DO alarms provide a close fit; one alarm per object requires a stored schedule. |
| 6. Agents SDK / PartyServer | MIT / ISC; 2026-11-21 / 2026-08-03; 6,021 / 1,317 stars [A] [PS] | yes | Underlying DO and Worker limits [D] [W] | N2 P, N4 P, N5 P, N6 P | copy the pattern: scheduling and socket helpers are useful, but do not establish Forge authorization or cursor semantics. |
| 7. Web Push and VAPID | Standards and browser/platform terms; no single release | yes | Worker 100,000 requests/day [W]; Apple payload 4 KB [AP] | N4 P, N5 P, N6 P | use it: standard phone delivery, subject to permission and device behavior. |
| 8. ntfy | Apache-2.0 and GPLv2 components; 2026-11-20; 35,673 stars [NT] | no, server | Hosted limits depend on plan; no verified numeric limit; separate from Cloudflare free tier | N4 P, N5 P, N7 P, N8 P | do not use: extra infrastructure and iOS self-host relay. |
| 9. Novu | MIT core, commercial enterprise folders; 2026-11-21; 40,399 stars [NV] | no, full server | Hosted free quota not verified; separate from Cloudflare limits | N4 P, N7 P, N8 P | do not use: a separate infrastructure stack is disproportionate for one owner. |
| 10. Gotify / Apprise / UnifiedPush | Gotify API reports NOASSERTION; Apprise BSD-2-Clause, 2026-11-21, 17,805 stars; UnifiedPush license/date not verified [GO] [AA] [UP] | no for full server/tool | Hosting or distributor limits not verified | N4 P, N7 P | do not use: none establishes the requested installed iPhone and Android web-app path. |
| 11. HumanLayer | Apache-2.0 with vendored exceptions; 2026-11-16; 12,923 stars [HL] | no verified whole-product deployment | Hosting costs and limits not verified | N1 P, N3 P, N7 P, N8 P | copy the pattern: approval records are useful evidence, not a drop-in Forge authority. |
| 12. MCP elicitation / input_required | Specification, not an executable server; license not checked; 2026-07-28 protocol [M] | yes as an interface, implementation dependent | Underlying Worker/DO allocation [W] [D] | N1 P, N2 P | copy the pattern: client compatibility and durable resume must be implemented separately. |
| 13. Vercel Board public package | Apache-2.0; 2026-11-21; 180 stars [B] | no verified full deployment | Hosted free terms are not a Cloudflare allocation; numeric limit not verified | N1 P, N2 P, N3 P, N7 P | copy the pattern: event cursors and typed messages inform Forge, while its approval authority remains separate. |
| 14. Nightmail | GitHub API reports no license; 2026-11-21; 37 stars [NM] | yes for API, but needs PostgreSQL, R2 and SES | Hosted 3,000 sent and 3,000 received/month; outside Cloudflare [NMP] | N2 P, N5 P, N7 P | do not use: undeclared license and external dependencies. |

Candidate details and limits: alarms are at-least-once and can retry, so delivery must be idempotent [AL]; WebSocket events may be lost at disconnect, so a persisted log, replay cursor and deduplication are required. SSE and long poll also require cursor handling. Workflows waits can be signaled through `waitForEvent` [EV], but authorization and delivery remain application work. PartyServer is a DO WebSocket helper; the Agents SDK provides scheduling and human-in-the-loop features [A] [PS]. The exact integration of its approval helper with Forge is untested. The Cloudflare push example sends encrypted notifications and removes dead subscriptions [PUSH]. `high` Web Push urgency is a delivery hint, not a guarantee of sound, priority bypass or time-sensitive entitlement [AP]. Browser notification permissions and device settings are outside the server's control. ntfy self-hosting iOS requires an upstream APNs-connected relay [NTC]. Novu's enterprise folders have different terms [NV]. The existing Board and Nightmail reports are comparison inputs, not fresh demonstrations of these products. [B] [NM]

# The three decision-gating facts

1. **Cost of waiting.** Cloudflare says: "Hibernated WebSocket connections stay connected." It also requires that "No request/event is still being processed" for hibernation [L]. Pricing says: "Durable Objects that are idle and eligible for hibernation are not billed for duration" [D]. A pending long poll is an active request, so it cannot meet that condition; this is an inference from the two documented rules. An agent connects outbound to an inbound hibernating DO socket, not an outbound socket from the DO. A conventional DO WebSocket accepted with the standard API does incur connected duration [D].
2. **Phone behavior.** The Notifications standard says: "The result of this situation is a single notification; the second one replaces the first having the same tag." [NOT] This is the standard's same-origin, nonempty-tag algorithm, not proof for either physical phone. Native replacement is conditional on platform support; otherwise the old notification is removed and the new one shown. `renotify` requests an alert but the user agent may choose whether to alert. Apple says: "Add web push to Home Screen web apps in iOS 16.4 or later" [AP]. The owner must install to the Home Screen, grant notification permission following a user gesture, and retain a valid subscription; Apple also requires a service worker and visible pushes [AP]. Device-specific replacement and repeated sound remain unverified. Push `Topic` collapse before delivery is distinct from displayed notification `tag` replacement.
3. **Free limits.** Cloudflare's table gives DO "100,000 / day" requests and "13,000 GB-s / day" duration [D]; 5 million rows read/day, 100,000 rows written/day and 5 GB total are also included. It says Workflow "waiting" instances "do not count towards concurrency limits" [WF]; Free has 100,000 executions/day and 100 concurrent running instances. Queues includes "10,000 operations/day" and 24-hour retention [Q]. For 50 asks/day and four scheduled delivery attempts each, the design implies up to 200 planned attempts/day before retries, subscriptions and other traffic. This arithmetic is not a quota guarantee: requests, CPU, rows, concurrent work, existing shared usage and external service limits must be measured. Free-plan DO operations exceeding a limit fail [D].

# Proof we could run

1. Hold one long poll and one hibernating socket for an hour in comparable isolated objects. Measure dashboard GB-s, requests, active time and reconnects. Expect lower idle socket duration. Change our mind if measured savings are negligible after realistic keepalives or socket reliability is worse.
2. Send an answer while the agent is disconnected, then reconnect with its last cursor; repeat with duplicate messages and simultaneous handoffs. Measure missed and duplicate answers and unauthorized writes. Expect zero lost or unauthorized accepted answers; any failure blocks release.
3. On a real iPhone and Android phone, install the web app, grant permission, send four pushes with the same origin and tag at 0, 5, 15 and 30 minutes, including after dismissal and while offline. Count visible notifications, alerts and arrival delays. Expect one current visible notification while the previous one remains present; if either device behaves differently, change the product promise or channel.
4. Run at least 50 asks in one day against a separate free account with representative existing traffic and forced retries. Measure requests, GB-s, row reads/writes, Worker CPU and failures. Expect headroom below all limits; if any quota is close or exceeded, redesign or revise the zero-cost promise.
5. Revoke a subscription, stop the laptop and delay the phone connection. Measure alarm delay, rejected subscription cleanup, inbox recovery and final answer-to-agent wake latency. Expect the server inbox to retain the answer independently of the laptop; repeated missed reminders or lost state changes the design.

# Limits

I did not run the software, inspect deployment configuration, or test phones. A standard or vendor document describes intended behavior, not observed end-to-end reliability. The user's existing reports supplied Board and Nightmail details; their underlying implementations were not re-audited here. GitHub metadata is a snapshot, and no release date was independently established for most entries. The precise Workers runtime compatibility flags and dependency versions for `web-push` were not verified. No independent primary evidence established Android and iPhone replacement behavior; the standard gives a target for testing. Apple-specific time-sensitive entitlement availability for web push was not established, so no such capability is assumed. The precise hosted free limits and full license breakdown for ntfy, Novu, Gotify, Apprise and UnifiedPush were not established. Slack delivery and verified-person mapping require design and testing. Existing Forge OAuth files were listed from `origin/main`, but its deployed identity guarantees and actual free allocation usage were not verified. No claim of N8 maturity follows from stars alone.

[D]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[L]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[W]: https://developers.cloudflare.com/workers/platform/limits/
[WF]: https://developers.cloudflare.com/workflows/reference/limits/
[Q]: https://developers.cloudflare.com/queues/platform/pricing/
[AL]: https://developers.cloudflare.com/durable-objects/api/alarms/
[EV]: https://developers.cloudflare.com/workflows/build/events-and-parameters/
[PUSH]: https://developers.cloudflare.com/agents/communication-channels/webhooks/push-notifications/
[NOT]: https://notifications.spec.whatwg.org/#showing-a-notification
[AP]: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
[A]: https://github.com/cloudflare/agents
[PS]: https://github.com/cloudflare/partykit
[NT]: https://github.com/binwiederhier/ntfy
[NTC]: https://docs.ntfy.sh/config/
[NV]: https://github.com/novuhq/novu
[GO]: https://github.com/gotify/server
[AA]: https://github.com/caronc/apprise
[UP]: https://unifiedpush.org/
[HL]: https://github.com/humanlayer/humanlayer
[M]: https://modelcontextprotocol.io/specification/2026-07-28/changelog
[B]: https://github.com/vercel/board
[NM]: https://github.com/anomalyco/nightmail
[NMP]: https://nightmail.dev/

COVERED 14 OF 14
