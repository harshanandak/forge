Decisions needed: none.

# Forge wait trial

| Measurement | A · Polling | B · Event wait | C · Hibernating socket |
| --- | ---: | ---: | ---: |
| M1 · Wake median / p95 / max (ms, 200 trials) | 497.54 / 1041.57 / 2062.36 | 19.31 / 76.95 / 404.91 | 5.93 / 21.59 / 338.45 |
| M2 · Reads / HTTP requests / timer callbacks (120 s) | 124 / 5 / 119 | 5 / 5 / 4 | 1 / 1 / 0 |
| M2 · Reads / HTTP requests / timer callbacks (scaled to 1 h) | 3720 / 150 / 3570 | 150 / 150 / 120 | 30 / 30 / 0 |
| M3 · Missed on reconnect with position (out of 100) | 0 | 0 | 0 |
| M3 · Missed on reconnect without position (out of 100) | n/a | n/a | 100 |
| M4 · Missed when posted before waiting (out of 100) | 0 | 0 | 0 |
| M5 · Wake p95 (ms) / total reads (200 waiters) | 4703.63 / 600 | 47.68 / 200 | 8.50 / 200 |
| M6 · Constructor count before / after 120 s, answer arrived | n/a | n/a | 0 / 1, yes |

## What the numbers show

The socket had the shortest wake times in both latency measurements and needed zero timer callbacks while idle. Event waiting read once per request and used its timer only to end the 25-second wait. Polling had a 4.70-second p95 with 200 waiters, well above its one-second polling interval. All three caught up when given the last seen position, and the socket's live-only reconnect missed every answer posted during disconnection. The local runtime constructed the mailbox again while the idle socket stayed connected, then delivered the answer on that socket.

## Rerun

Run `bun run trial` from `E:/Personal-Projects/forge-new/.overseer/spikes/forge-1761-wait-trial`. It starts Wrangler locally, writes `results.json` and shuts down. The two attempts took 568.20 seconds total (9 min 28 s), including startup and shutdown. Versions were Wrangler 4.152.0, workerd 1.20261019.1, Bun 1.4.4, Node 24.18.0 and Windows 11 Home build 26300.

M1 used the same 200 seeded delays from 500 to 3000 ms for each method, in waves of 20. Each wake time starts when the driver issues the answer request and ends when the client receives the matching answer. An answer in this spike carries its ask ID and sequence number. M2 and M6 shared the socket's idle window, with the counter snapshot taken before counting the answer post. Reads count queries for answers. HTTP counts include socket upgrades and exclude counter probes. The one-hour row multiplies each two-minute count by 30, including the socket's initial request and read.

## Failures and limits

The first socket attempt logged errors when the server tried to echo the reserved close code 1005. I stopped that attempt, fixed the close handler and reran every socket measurement against the same on-disk mailbox. The table retains the completed A and B samples from the first run. All requested sample counts and idle windows were completed across the two attempts.

The trial used one laptop and included the overhead of writing SQLite counters. The cause of the polling delay under load remains unmeasured. The socket handshake was live-only when the position was omitted, so the 100 misses show what that reconnect policy leaves out. Edge latency and billing were outside this local trial. The worker and driver total 425 lines, including startup, validation and process cleanup.

## Process check

Each attempt ran one Wrangler server. The final process check saw two Node processes for Wrangler (34564 and 8636) and two workerd processes (11176 and 20152) before shutdown. The Windows process list showed zero trial Wrangler or workerd processes after each shutdown.
