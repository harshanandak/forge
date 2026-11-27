import type { ChatMessageEvent } from "../contract/chat.ts";
import {
  AgentPostJournalError,
  agentPost,
  recoverAgentPosts,
} from "./agent-posts.ts";
import type { Conversation, Person, Session } from "../contract/domain.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { bestEffort, type Notice, postNotice } from "./doorbell.ts";
import {
  conversation,
  enterThread,
  messageText,
  postLoopPause,
  recordThread,
  str,
  UNCONFIRMED_MESSAGE_PREFIX,
} from "./thread.ts";

export function frontSession(
  ctx: CoreContext,
  personId: string,
  projectId: string,
): Session | undefined {
  const bell = ctx.deps.config.doorbells.find(
    (entry) => entry.personId === personId && entry.projectId === projectId,
  );
  return (
    bell &&
    ctx.store.sessions
      .sessionsByThread(personId, bell.frontThreadId)
      .filter((s) => s.projectId === undefined || s.projectId === projectId)
      .toSorted((a, b) => b.createdAt - a.createdAt)[0]
  );
}

function target(ctx: CoreContext, chat: Conversation): Session | undefined {
  const { sessions } = ctx.store;
  if (!chat.sessionId)
    return chat.projectId
      ? frontSession(ctx, chat.personId, chat.projectId)
      : undefined;
  const current = sessions.session(chat.sessionId);
  if (!current) return;
  const compatible =
    current.projectId === undefined || current.projectId === chat.projectId
      ? current
      : undefined;
  if (
    !current.threadId ||
    ctx.deps.now() - current.lastSeenAt <= LIMITS.liveSessionMs
  )
    return compatible;
  const newer = sessions
    .sessionsByThread(chat.personId, current.threadId)
    .filter(
      (s) =>
        s.createdAt > current.createdAt &&
        (s.projectId === undefined || s.projectId === chat.projectId),
    )
    .toSorted((a, b) => b.createdAt - a.createdAt)[0];
  if (!newer) return compatible;
  ctx.deps.db
    .prepare("UPDATE conversations SET session_id=? WHERE conversation_id=?")
    .run(newer.sessionId, chat.conversationId);
  return newer;
}

export function insertItem(
  ctx: CoreContext,
  item: {
    owner: Person;
    sender: Person;
    agent?: string;
    target?: Session | undefined;
    chat?: Conversation;
    projectId?: string | undefined;
    text: string;
    event?: ChatMessageEvent;
  },
) {
  const { db, now } = ctx.deps;
  const { owner, sender, chat, projectId, event, agent } = item;
  const selected = item.target;
  const parent =
    selected?.parentSessionId &&
    now() - selected.lastSeenAt > LIMITS.liveSessionMs
      ? ctx.store.sessions.session(selected.parentSessionId)
      : undefined;
  const redirected =
    parent?.personId === owner.personId &&
    (parent.projectId === undefined || parent.projectId === projectId)
      ? parent
      : undefined;
  const session = (redirected ?? selected)?.sessionId;
  const id = ctx.store.newId("item");
  const key = event ? JSON.stringify([event.eventKey, owner.personId]) : id;
  const received =
    event && /^\d+\.\d+$/.test(event.chatMessageId)
      ? Math.trunc(Number(event.chatMessageId) * 1000)
      : now();
  const result = db
    .prepare(
      `INSERT INTO inbox_items
    (item_id,dedupe_key,owner_person_id,target_session_id,for_subagent_session_id,conversation_id,project_id,
      kind,sender_kind,sender_person_id,sender_session_id,sender_name,not_your_owner,held,text,chat_message_id,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
    )
    .run(
      id,
      key,
      owner.personId,
      session ?? null,
      redirected ? (selected?.sessionId ?? null) : null,
      chat?.conversationId ?? null,
      projectId ?? null,
      agent ? "agent_message" : "chat_message",
      agent ? "agent" : "person",
      sender.personId,
      agent ?? null,
      sender.displayName,
      Number(!!agent || sender.personId !== owner.personId),
      Number(projectId === undefined),
      item.text,
      event?.chatMessageId ?? null,
      received,
    );
  return { id, fresh: result.changes !== 0, session };
}

function createConversation(
  ctx: CoreContext,
  event: ChatMessageEvent,
  owner: Person,
  projectId: string | undefined,
) {
  const id = ctx.store.newId("conversation");
  const row = ctx.deps.db
    .prepare(
      `INSERT INTO conversations
    (conversation_id,project_id,person_id,adapter,chat_thread_id,channel_id,is_direct,created_by,created_at)
    VALUES (?,?,?,'slack',?,?,?,'slack',?) RETURNING *`,
    )
    .get(
      id,
      projectId ?? null,
      owner.personId,
      event.chatThreadId,
      event.channelId,
      Number(event.isDirect),
      ctx.deps.now(),
    );
  if (!row) throw new Error("Conversation insert returned no row");
  return conversation(row);
}

export async function route(
  ctx: CoreContext,
  event: ChatMessageEvent,
): Promise<void> {
  const { chat } = ctx;
  if (!chat) return;
  const { db, config, people } = ctx.deps;
  const { sessions } = ctx.store;
  const sender = people.bySlackUserId(event.slackUserId);
  const notes: string[] = [];
  const queue: Notice[] = [];
  let react = false;
  const { channelId, chatThreadId, chatMessageId, isDirect, mentionsBot } =
    event;
  let post: ReturnType<typeof agentPost>;
  try {
    post = isDirect ? undefined : agentPost(ctx, chatThreadId);
  } catch (error) {
    if (!(error instanceof AgentPostJournalError)) throw error;
    ctx.deps.log.warn("agent_post_journal_invalid", { key: error.key });
    post = undefined;
  }
  const ref = { channelId, chatThreadId, chatMessageId };
  const ephemeral = ctx.store.tx(() => {
    const existing = db
      .prepare(
        `SELECT * FROM conversations WHERE adapter='slack' AND chat_thread_id=?
      AND channel_id=? AND is_direct=? ORDER BY rowid`,
      )
      .all(chatThreadId, channelId, Number(isDirect))
      .map(conversation);
    const member = (projectId: string, person: Person) =>
      sessions.isMember(projectId, person.personId);
    const project = config.projects.find(
      (p) => !isDirect && p.slackChannelId === channelId,
    );
    const root = existing[0];
    if (root && project && root.projectId !== project.projectId) return;
    if (!isDirect && !mentionsBot && !existing.length) return;
    if (!sender) {
      if (!isDirect && !mentionsBot && project)
        recordThread(ctx, event, project.projectId, "outsider", "");
      else return "You are not set up in Forge for this workspace.";
      return;
    }
    if (!isDirect && !project) return "This channel is not a Forge project.";
    if (project && !member(project.projectId, sender))
      return "You are not a member of this Forge project.";
    const text = messageText(ctx, event);
    const targets = [...new Set(event.mentionedSlackUserIds)].filter(
      (id) => id !== event.slackUserId,
    );
    const named = targets.flatMap((id) => {
      const person = people.bySlackUserId(id);
      return person ? [person] : [];
    });
    const deliver = (
      owner: Person,
      projectId: string | undefined,
      current?: Conversation,
    ) => {
      const thread =
        current ?? createConversation(ctx, event, owner, projectId);
      const item = insertItem(ctx, {
        owner,
        sender,
        projectId,
        chat: thread,
        target: target(ctx, thread),
        text,
        event,
      });
      if (item.fresh && projectId)
        queue.push({
          person: owner,
          projectId,
          conversation: thread,
          items: [item.id],
          answers: [],
          ...(item.session === undefined ? {} : { session: item.session }),
        });
    };
    const bindAndRelease = (current: Conversation, projectId: string) => {
      const session = frontSession(ctx, sender.personId, projectId)?.sessionId;
      db.prepare(
        "UPDATE conversations SET project_id=? WHERE conversation_id=?",
      ).run(projectId, current.conversationId);
      const released = db
        .prepare(
          `UPDATE inbox_items SET held=0,project_id=?,target_session_id=?
        WHERE held=1 AND conversation_id=? RETURNING item_id`,
        )
        .all(projectId, session ?? null, current.conversationId);
      const bound = { ...current, projectId };
      queue.push({
        person: sender,
        projectId,
        conversation: bound,
        items: released.map((row) => str(row.item_id)),
        answers: [],
        ...(session === undefined ? {} : { session }),
      });
      return bound;
    };
    if (isDirect) {
      if (named[0]) {
        const label = named[0].displayName;
        notes.push(
          "Ask " +
            label +
            "'s agent in a project channel so " +
            label +
            " can see it.",
        );
        return;
      }
      const current = existing.find(
        (entry) => entry.personId === sender.personId,
      );
      const projects = config.projects.filter((p) =>
        member(p.projectId, sender),
      );
      if (current?.projectId && !member(current.projectId, sender)) return;
      const pickerKey = "project_picker:" + (current?.conversationId ?? "");
      if (
        current &&
        db.prepare("SELECT value FROM meta WHERE key=?").get(pickerKey)
          ?.value === event.eventKey
      )
        return;
      if (current && !current.projectId) {
        const picker = event.text.trim().toLowerCase();
        const matches = projects.filter((p) =>
          [p.projectId, p.name].some((value) => value.toLowerCase() === picker),
        );
        const picked = matches.length === 1 ? matches[0] : undefined;
        if (picked) {
          const { projectId } = picked;
          db.prepare(
            "INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(pickerKey, event.eventKey);
          bindAndRelease(current, projectId);
          return;
        }
      }
      const chosen =
        current?.projectId ??
        (projects.length === 1 ? projects[0]?.projectId : undefined);
      const thread =
        current && !current.projectId && chosen !== undefined
          ? bindAndRelease(current, chosen)
          : current;
      deliver(sender, chosen, thread);
      if (!chosen && !current)
        notes.push(
          [
            "Which project? Reply with one of:",
            ...projects.map(
              (p) => p.name + (p.purpose ? ": " + p.purpose : ""),
            ),
          ].join("\n"),
        );
      return;
    }
    if (!project) return;
    const { projectId } = project;
    const equipped = (person: Person) =>
      config.doorbells.some(
        (entry) =>
          entry.personId === person.personId && entry.projectId === projectId,
      );
    let recipients: Person[] = [];
    if (mentionsBot && targets.length) {
      if (targets.length > LIMITS.mentionTargetsMax) {
        notes.push("Name at most " + LIMITS.mentionTargetsMax + " people.");
        if (
          existing.length > 0 &&
          !recordThread(
            ctx,
            event,
            projectId,
            "person",
            text,
            sender.personId,
            mentionsBot,
          )
        )
          notes.length = 0;
        return;
      }
      if (!named.length)
        notes.push(
          "None of those people are set up in Forge for this project.",
        );
      recipients = named.filter((person) => {
        if (member(projectId, person) && equipped(person)) return true;
        notes.push(
          person.displayName + " has no agent set up for " + project.name + ".",
        );
        return false;
      });
      react = recipients.length > 0;
    } else if (mentionsBot) {
      const owner =
        existing.some((entry) => entry.personId === sender.personId) ||
        equipped(sender)
          ? sender
          : people.byPersonId(project.frontPersonId);
      if (owner && member(projectId, owner)) recipients = [owner];
    } else {
      const latest = db
        .prepare(
          `SELECT person_id FROM thread_messages WHERE adapter='slack'
        AND chat_thread_id=? AND kind='agent'
        AND (chat_message_id IS NULL OR chat_message_id NOT LIKE ?)
        ORDER BY seq DESC LIMIT 1`,
        )
        .get(chatThreadId, UNCONFIRMED_MESSAGE_PREFIX + "%");
      const author =
        post?.phase === "confirmed" && post.conversation.channelId === channelId
          ? post.personId
          : latest?.person_id;
      const recipient =
        existing.find((entry) => entry.personId === author) ?? root;
      const owner = recipient && people.byPersonId(recipient.personId);
      if (owner && member(projectId, owner)) recipients = [owner];
    }
    if (!recipients.length && !existing.length) return;
    if (
      !recordThread(
        ctx,
        event,
        projectId,
        "person",
        text,
        sender.personId,
        mentionsBot,
      )
    ) {
      notes.length = 0;
      react = false;
      return;
    }
    for (const owner of recipients)
      deliver(
        owner,
        projectId,
        existing.find((entry) => entry.personId === owner.personId),
      );
    const owner = recipients[0];
    if (
      mentionsBot &&
      !targets.length &&
      owner &&
      owner.personId !== sender.personId
    ) {
      const text =
        sender.displayName +
        " has no agent set up for " +
        project.name +
        ". " +
        owner.displayName +
        "'s agent will see this.";
      const found = db
        .prepare(
          `SELECT 1 FROM thread_messages WHERE adapter='slack' AND chat_thread_id=?
        AND kind='system' AND text=?`,
        )
        .get(chatThreadId, text);
      if (!found) {
        db.prepare(
          `INSERT INTO thread_messages (adapter,chat_thread_id,channel_id,project_id,kind,text,created_at)
          VALUES ('slack',?,?,?,'system',?,?)`,
        ).run(chatThreadId, channelId, projectId, text, ctx.deps.now());
        notes.push(text);
      }
    }
    return;
  });
  if (ephemeral)
    await bestEffort(ctx, () =>
      chat.postEphemeral(ref, event.slackUserId, ephemeral),
    );
  for (const text of notes)
    await bestEffort(ctx, () => postNotice(chat, ref, text));
  if (react) await bestEffort(ctx, () => chat.react(ref, "eyes"));
  for (const notice of queue) await ctx.notify(notice);
  if (!post || post.phase === "reserved") return;
  const release = await enterThread(ctx, chatThreadId);
  await bestEffort(ctx, async () => {
    const recovered = recoverAgentPosts(ctx, chatThreadId);
    if (recovered) await postLoopPause(ctx, recovered);
  }).finally(release);
}
