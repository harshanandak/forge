import type { Person } from "../contract/domain.ts";
import { redactSecretText } from "../contract/errors.ts";
import { ID_PATTERN, ID_PREFIX } from "../contract/ids.ts";
import type {
  CreatePeopleDirectory,
  HubConfig,
  HubDb,
} from "../contract/runtime.ts";

export function readStoredDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid hub display name.");
  return redactSecretText(value);
}

export function isTelegramId(value: unknown, signed = false): value is string {
  return (
    typeof value === "string" &&
    (signed ? /^-?[1-9][0-9]*$/ : /^[1-9][0-9]*$/).test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

export const createPeopleDirectory: CreatePeopleDirectory = (entries) => {
  const byPerson = new Map<string, Person>();
  const bySlack = new Map<string, Person>();
  const byTelegram = new Map<string, Person>();
  const prefix = ID_PREFIX.person + "_";
  const slackId = /^[UW][A-Z0-9]+$/;
  for (const entry of entries) {
    const { personId, slackUserId, telegramUserId } = entry;
    const valid = ID_PATTERN.test(personId) && personId.startsWith(prefix);
    if (!valid || byPerson.has(personId))
      throw new Error("Invalid or duplicate personId.");
    if (slackUserId !== undefined) {
      const validSlack = slackId.test(slackUserId);
      if (!validSlack || bySlack.has(slackUserId))
        throw new Error("Invalid or duplicate slackUserId.");
    }
    if (
      telegramUserId !== undefined &&
      (!isTelegramId(telegramUserId) || byTelegram.has(telegramUserId))
    )
      throw new Error("Invalid or duplicate telegramUserId.");
    const person = Object.freeze({ ...entry });
    byPerson.set(personId, person);
    if (slackUserId !== undefined) bySlack.set(slackUserId, person);
    if (telegramUserId !== undefined) byTelegram.set(telegramUserId, person);
  }

  return {
    all: () => [...byPerson.values()],
    byPersonId: (id) => byPerson.get(id),
    byChatUserId: (adapter, id) =>
      adapter === "slack"
        ? bySlack.get(id)
        : adapter === "telegram"
          ? byTelegram.get(id)
          : undefined,
    bySlackUserId: (id) => bySlack.get(id),
  };
};

export function syncDirectory(db: HubDb, config: HubConfig): void {
  db.transaction(() => {
    db.exec(`
      UPDATE people SET slack_user_id = NULL WHERE slack_user_id IS NOT NULL;
      UPDATE projects SET slack_channel_id = NULL, summary_channel_id = NULL
        WHERE slack_channel_id IS NOT NULL;
      DELETE FROM project_members;
    `);
    const person = db.prepare(`
      INSERT INTO people (person_id, display_name, slack_user_id) VALUES (?, ?, ?)
      ON CONFLICT(person_id) DO UPDATE SET
        display_name = excluded.display_name, slack_user_id = excluded.slack_user_id
    `);
    for (const p of config.people)
      person.run(p.personId, p.displayName, p.slackUserId ?? null);
    const people = JSON.stringify(
      config.people.map(({ personId }) => personId),
    );
    const revokedAt = Date.now();
    for (const table of ["tokens", "host_keys"])
      db.prepare(
        `UPDATE ${table} SET revoked_at = ? WHERE revoked_at IS NULL
        AND person_id NOT IN (SELECT value FROM json_each(?))`,
      ).run(revokedAt, people);
    const project = db.prepare(`
      INSERT INTO projects (project_id, name, purpose, slack_channel_id, summary_channel_id, front_person_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET name = excluded.name, purpose = excluded.purpose,
        slack_channel_id = excluded.slack_channel_id, summary_channel_id = excluded.summary_channel_id,
        front_person_id = excluded.front_person_id
    `);
    const member = db.prepare(
      "INSERT INTO project_members (project_id, person_id) VALUES (?, ?)",
    );
    for (const p of config.projects) {
      project.run(
        p.projectId,
        p.name,
        p.purpose ?? null,
        p.slackChannelId ?? null,
        p.summaryChannelId ?? p.slackChannelId ?? null,
        p.frontPersonId,
      );
      for (const id of p.memberIds) member.run(p.projectId, id);
    }
  });
}
