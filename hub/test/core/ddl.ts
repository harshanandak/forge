import { CHAT_STATE_DDL } from "../../src/contract/chat-state.ts";
import type { HubDb } from "../../src/contract/runtime.ts";

const hubDdl = `
create table meta (key text primary key not null, value text not null);

create table people (
  person_id text primary key not null,
  display_name text not null,
  slack_user_id text unique
);

create table projects (
  project_id text primary key not null,
  name text not null,
  purpose text,
  slack_channel_id text unique,
  summary_channel_id text,
  front_person_id text not null references people(person_id),
  check ((slack_channel_id is null) = (summary_channel_id is null))
);

create table project_members (
  project_id text not null references projects(project_id),
  person_id text not null references people(person_id),
  primary key (project_id, person_id)
);

create table tokens (
  token_id text primary key not null,
  person_id text not null references people(person_id),
  label text not null,
  token_hash text not null unique,
  created_at integer not null,
  last_used_at integer,
  revoked_at integer
);

create table host_keys (
  host_instance_id text primary key not null,
  person_id text not null references people(person_id),
  label text not null,
  key_hash text not null unique,
  created_at integer not null,
  last_used_at integer,
  revoked_at integer
);

create table sessions (
  session_id text primary key not null,
  person_id text not null references people(person_id),
  host text not null check (host in ('claude','codex','opencode','t3','other')),
  host_instance_id text references host_keys(host_instance_id),
  host_session_id text,
  start_source text check (start_source in ('startup','resume','clear','compact')),
  thread_id text,
  parent_session_id text references sessions(session_id),
  project_id text references projects(project_id),
  mode text not null check (mode in ('normal','reply_only')),
  mode_reason text not null check (mode_reason in ('start','unbound_start','resume_unknown','read_untrusted','request_approved')),
  mode_changed_at integer not null,
  untrusted_read_seq integer not null default 0,
  created_at integer not null,
  last_seen_at integer not null,
  check ((host_instance_id is null) = (host_session_id is null)),
  check ((host_instance_id is null) = (start_source is null))
);
create unique index sessions_host_key on sessions(person_id, host_instance_id, host, host_session_id)
  where host_instance_id is not null;
create index sessions_thread on sessions(person_id, thread_id) where thread_id is not null;

create table conversations (
  conversation_id text primary key not null,
  project_id text references projects(project_id),
  person_id text not null references people(person_id),
  session_id text references sessions(session_id),
  adapter text not null check (adapter = 'slack'),
  chat_thread_id text not null,
  channel_id text not null,
  is_direct integer not null,
  created_by text not null check (created_by in ('slack','agent')),
  context_seq integer not null default 0,
  created_at integer not null
);
create unique index conversations_thread_person on conversations(adapter, chat_thread_id, person_id);

create table inbox_items (
  item_id text primary key not null,
  dedupe_key text not null unique,
  owner_person_id text not null references people(person_id),
  target_session_id text references sessions(session_id),
  for_subagent_session_id text references sessions(session_id),
  conversation_id text references conversations(conversation_id),
  project_id text references projects(project_id),
  kind text not null check (kind in ('chat_message','agent_message','cli_message','system')),
  sender_kind text not null check (sender_kind in ('person','agent','cli','system')),
  sender_person_id text references people(person_id),
  sender_session_id text references sessions(session_id),
  sender_name text not null,
  not_your_owner integer not null,
  held integer not null default 0,
  text text not null,
  chat_message_id text,
  received_at integer not null,
  delivered_at integer,
  delivered_to_session_id text references sessions(session_id),
  acked_at integer,
  context_from_seq integer,
  context_to_seq integer,
  check ((context_from_seq is null) = (context_to_seq is null)),
  check ((kind = 'agent_message') = (sender_kind = 'agent')),
  check ((kind = 'cli_message') = (sender_kind = 'cli')),
  check (kind not in ('agent_message','cli_message') or not_your_owner = 1)
);
create index inbox_pending on inbox_items(owner_person_id, acked_at, received_at);
create index inbox_delivered on inbox_items(delivered_to_session_id, acked_at);

create table thread_messages (
  seq integer primary key autoincrement,
  adapter text not null check (adapter = 'slack'),
  chat_thread_id text not null,
  channel_id text not null,
  project_id text not null references projects(project_id),
  chat_message_id text,
  kind text not null check (kind in ('person','agent','outsider','system')),
  person_id text references people(person_id),
  session_id text references sessions(session_id),
  text text not null,
  mentioned_bot integer not null default 0,
  edited_at integer,
  deleted integer not null default 0,
  created_at integer not null,
  check ((kind in ('person','agent')) = (person_id is not null)),
  check (kind <> 'outsider' or text = '')
);
create index thread_messages_thread on thread_messages(chat_thread_id, seq);
create unique index thread_messages_ref on thread_messages(adapter, chat_thread_id, chat_message_id)
  where chat_message_id is not null;

create table reply_owed (
  item_id text primary key not null references inbox_items(item_id),
  session_id text not null references sessions(session_id),
  conversation_id text not null references conversations(conversation_id),
  answered integer not null default 0,
  created_at integer not null
);
create index reply_owed_session on reply_owed(session_id);

create table asks (
  ask_id text primary key not null,
  project_id text not null references projects(project_id),
  kind text not null check (kind in ('choice','work_request')),
  requested_action text not null check (requested_action in ('choice','work')),
  from_session_id text not null references sessions(session_id),
  from_person_id text not null references people(person_id),
  from_session_untrusted_seq integer not null,
  question text not null,
  choices_json text not null,
  allowed_json text not null,
  issue_id text,
  inbox_item_id text references inbox_items(item_id),
  status text not null check (status in ('open','answered','expired')),
  created_at integer not null,
  expires_at integer not null,
  check ((kind = 'choice') = (requested_action = 'choice'))
);

create table ask_deliveries (
  ask_id text not null references asks(ask_id),
  person_id text not null references people(person_id),
  delivery_state text not null check (delivery_state in ('pending','posting','delivered','unknown','refused')),
  chat_thread_id text,
  chat_message_id text,
  channel_id text,
  delivered_at integer,
  edited_at integer,
  primary key (ask_id, person_id),
  check ((delivery_state = 'delivered') = (chat_message_id is not null and chat_thread_id is not null and channel_id is not null and delivered_at is not null))
);

create table ask_answers (
  ask_id text not null references asks(ask_id),
  choice_id text not null,
  answered_by_person_id text not null references people(person_id),
  answered_at integer not null,
  source text not null check (source in ('button','digit')),
  event_key text not null,
  delivered_at integer,
  acked_at integer
);
create unique index ask_answers_lock on ask_answers(ask_id);

create table answer_attempts (
  event_key text primary key not null,
  ask_id text not null,
  slack_user_id text not null,
  choice_id text not null,
  outcome text not null check (outcome in ('locked','already_answered','expired','not_allowed','invalid_choice','unknown_ask','unknown_answerer')),
  at integer not null
);

create table permits (
  permit_id text primary key not null,
  person_id text not null references people(person_id),
  project_id text not null references projects(project_id),
  scope_key text not null,
  issue_id text,
  request_ask_id text references asks(ask_id),
  source text not null check (source in ('owner_session','approved_request')),
  evidence text not null check (evidence in ('clean_bound_session','owner_approval')),
  created_at integer not null,
  revoked_at integer,
  check ((source = 'approved_request') = (evidence = 'owner_approval'))
);
create unique index permits_active on permits(person_id, project_id, scope_key)
  where revoked_at is null;

create table summaries (
  project_id text primary key not null references projects(project_id),
  publication_key text not null unique,
  post_state text not null check (post_state in ('unposted','posting','posted')),
  chat_thread_id text,
  chat_message_id text,
  channel_id text,
  revision integer not null,
  published_revision integer not null default 0,
  updated_at integer not null
);

create table summary_lines (
  project_id text not null references projects(project_id),
  person_id text not null references people(person_id),
  issue_key text not null,
  state text not null check (state in ('working','blocked','done')),
  text text not null,
  host_label text not null,
  updated_at integer not null,
  primary key (project_id, person_id, issue_key)
);

create table ask_edit_effects (
  ask_id text not null references asks(ask_id),
  person_id text not null references people(person_id),
  status text not null check (status in ('pending','done')),
  attempts integer not null default 0,
  next_attempt_at integer not null,
  updated_at integer not null,
  primary key (ask_id, person_id)
);

create table summary_effects (
  project_id text primary key not null references projects(project_id),
  target_revision integer not null,
  status text not null check (status in ('pending','done')),
  attempts integer not null default 0,
  next_attempt_at integer not null,
  updated_at integer not null
);

create table doorbell_rings (
  ring_id text primary key not null,
  person_id text not null references people(person_id),
  project_id text not null,
  session_id text,
  ids_json text not null,
  sent_at integer not null,
  outcome text not null check (outcome in ('sent','not_configured','failed')),
  http_status integer
);
`;

const hubDdlV2 = hubDdl
  .replaceAll("adapter = 'slack'", "adapter in ('slack','telegram')")
  .replace(
    "created_by in ('slack','agent')",
    "created_by in ('slack','telegram','agent')",
  )
  .replace(
    "  edited_at integer,\n  primary key (ask_id, person_id),",
    "  edited_at integer,\n  adapter text not null default 'slack' check (adapter in ('slack','telegram')),\n  primary key (ask_id, person_id),",
  )
  .replace("event_key text primary key not null", "event_key text not null")
  .replace(
    "  at integer not null\n);",
    "  at integer not null,\n  adapter text not null default 'slack' check (adapter in ('slack','telegram')),\n  primary key (adapter, event_key)\n);",
  );

export function createTestSchema(
  db: Pick<HubDb, "exec">,
  version: 1 | 2 = 1,
): void {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(version === 1 ? hubDdl : hubDdlV2);
  for (const sql of CHAT_STATE_DDL) db.exec(sql);
  db.exec(
    `INSERT INTO meta (key, value) VALUES ('schema_version', '${version}')`,
  );
}
