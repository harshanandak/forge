import { DurableObject } from "cloudflare:workers";

const waitMs = 25_000;
const empty = () => new Response(null, { status: 204 });

export class Mailbox extends DurableObject {
  waiters = new Map();

  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ask TEXT NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_ask_seq ON events(ask, seq)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS counters (reads INT, requests INT, timers INT, constructors INT)");
    this.sql.exec("INSERT INTO counters SELECT 0, 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM counters)");
    this.sql.exec("UPDATE counters SET constructors = constructors + 1");
  }

  stats() {
    return this.sql.exec("SELECT * FROM counters").one();
  }

  read(ask, after, timer = 0) {
    this.sql.exec("UPDATE counters SET reads = reads + 1, timers = timers + ?", timer);
    return this.sql.exec("SELECT seq, ask FROM events WHERE ask = ? AND seq > ? ORDER BY seq", ask, after).toArray();
  }

  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    const ask = searchParams.get("ask");
    const after = Number(searchParams.get("after") ?? 0);
    if (pathname === "/stats") return Response.json(this.stats());
    if (pathname === "/reset") {
      this.sql.exec("UPDATE counters SET reads = 0, requests = 0, timers = 0, constructors = 0");
      return Response.json(this.stats());
    }
    const before = searchParams.has("snapshot") ? this.stats() : undefined;
    this.sql.exec("UPDATE counters SET requests = requests + 1");
    if (pathname === "/answer") {
      const answer = this.sql.exec("INSERT INTO events (ask) VALUES (?) RETURNING seq, ask", ask).one();
      for (const waiter of this.waiters.get(ask) ?? []) {
        if (answer.seq > waiter.after) waiter.finish(answer);
      }
      for (const socket of this.ctx.getWebSockets(ask)) {
        const cursor = socket.deserializeAttachment();
        if (cursor && answer.seq > cursor.after) this.send(socket, answer);
      }
      return Response.json({ ...answer, before });
    }
    if (pathname === "/C") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [ask]);
      return new Response(null, { status: 101, webSocket: client });
    }
    const present = this.read(ask, after)[0];
    if (present) return Response.json(present);
    if (pathname === "/A") return this.poll(ask, after, request.signal);
    if (pathname === "/B") return this.eventWait(ask, after, request.signal);
    return new Response(null, { status: 404 });
  }

  async poll(ask, after, signal) {
    const deadline = Date.now() + waitMs;
    while (!signal.aborted && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      if (signal.aborted) {
        this.sql.exec("UPDATE counters SET timers = timers + 1");
        break;
      }
      const answer = this.read(ask, after, 1)[0];
      if (answer) return Response.json(answer);
    }
    return empty();
  }

  async eventWait(ask, after, signal) {
    const waiters = this.waiters.get(ask) ?? new Set();
    this.waiters.set(ask, waiters);
    const answer = await new Promise(resolve => {
      const waiter = { after, finish };
      const timer = setTimeout(() => {
        this.sql.exec("UPDATE counters SET timers = timers + 1");
        finish();
      }, waitMs);
      const abort = () => finish();
      function finish(answer) {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        waiters.delete(waiter);
        resolve(answer);
      }
      waiters.add(waiter);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    if (!waiters.size) this.waiters.delete(ask);
    return answer ? Response.json(answer) : empty();
  }

  send(socket, answer) {
    socket.serializeAttachment({ after: answer.seq });
    socket.send(JSON.stringify({ answer }));
  }

  webSocketMessage(socket, message) {
    const { after } = JSON.parse(message);
    const ask = this.ctx.getTags(socket)[0];
    socket.serializeAttachment({ after: after ?? 0 });
    if (after !== undefined) {
      for (const answer of this.read(ask, after)) this.send(socket, answer);
    }
    socket.send(JSON.stringify({ ready: true }));
  }

  webSocketClose(socket, code) {
    socket.close(code === 1005 || code === 1006 ? 1000 : code);
  }
}

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/health") return new Response("ok");
    return env.MAILBOX.getByName("trial").fetch(request);
  },
};

