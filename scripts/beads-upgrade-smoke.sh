#!/usr/bin/env bash
set -euo pipefail

BD_CMD="${BD_CMD:-bd}"
NODE_CMD="${NODE_CMD:-node}"
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
ARTIFACT_DIR="${BEADS_UPGRADE_SMOKE_ARTIFACT_DIR:-${PROJECT_ROOT}/.artifacts/beads-upgrade-smoke}"
COMMAND_LOG_PATH="${ARTIFACT_DIR}/commands.jsonl"
SUMMARY_PATH="${ARTIFACT_DIR}/summary.json"
CLEANUP_REASON="Beads upgrade smoke cleanup"
SMOKE_RUN_ID="${BEADS_UPGRADE_SMOKE_RUN_ID:-$(date +%s)-$$}"
PRIMARY_ISSUE_TITLE="Beads upgrade smoke primary (${SMOKE_RUN_ID})"
DEPENDENT_ISSUE_TITLE="Beads upgrade smoke dependent (${SMOKE_RUN_ID})"

node_fs_path() {
  case "$1" in
    /[A-Za-z]/*)
      _drive="$(printf '%s' "${1:1:1}" | tr '[:lower:]' '[:upper:]')"
      printf '%s:/%s\n' "$_drive" "${1:3}"
      ;;
    *)
      if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1"
      else
        printf '%s\n' "$1"
      fi
      ;;
  esac
}

mkdir -p "${ARTIFACT_DIR}"
: > "${COMMAND_LOG_PATH}"

created_issue_ids=()
closed_issue_ids=()
failed_step=""
failure_message=""

parse_issue_id() {
  local output="$1"
  if [[ "${output}" =~ Created[[:space:]]+issue:[[:space:]]*([[:alnum:]-]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "${output}" =~ \"id\"[[:space:]]*:[[:space:]]*\"([[:alnum:]-]+)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

find_issue_id_by_title() {
  local issue_title="$1"
  local list_output
  list_output="$("${BD_CMD}" list --json --limit=50 2>/dev/null)" || return 1

  "${NODE_CMD}" -e '
    const fs = require("node:fs");
    const [issueTitle] = process.argv.slice(1);
    try {
      const rows = JSON.parse(fs.readFileSync(0, "utf8"));
      if (!Array.isArray(rows)) {
        process.exit(1);
      }
      const match = rows.find((row) => row && row.title === issueTitle && typeof row.id === "string");
      if (!match) {
        process.exit(1);
      }
      process.stdout.write(match.id);
    } catch {
      process.exit(1);
    }
  ' "${issue_title}" <<< "${list_output}"
}

append_command() {
  local step="$1"
  local command_name="$2"
  local command_text="$3"
  local exit_code="$4"
  local stdout_path="$5"
  local stderr_path="$6"

  "${NODE_CMD}" -e '
    const fs = require("node:fs");
    const [logPath, step, commandName, commandText, exitCode, stdoutPath, stderrPath] = process.argv.slice(1);
    const entry = {
      step,
      commandName,
      commandText,
      exitCode: Number(exitCode),
      stdoutPath,
      stderrPath,
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  ' "$(node_fs_path "${COMMAND_LOG_PATH}")" "${step}" "${command_name}" "${command_text}" "${exit_code}" "$(node_fs_path "${stdout_path}")" "$(node_fs_path "${stderr_path}")"
}

read_output_snippet() {
  local file_path="$1"
  if [[ ! -f "${file_path}" ]]; then
    return 0
  fi

  "${NODE_CMD}" -e '
    const fs = require("node:fs");
    const [filePath] = process.argv.slice(1);
    const text = fs.readFileSync(filePath, "utf8");
    process.stdout.write(text.slice(0, 4096));
  ' "$(node_fs_path "${file_path}")"
}

write_summary() {
  local ok="$1"

  "${NODE_CMD}" -e '
    const fs = require("node:fs");
    const [
      commandLogPath,
      summaryPath,
      okValue,
      failedStep,
      failureMessage,
      artifactDir,
      createdJson,
      closedJson,
    ] = process.argv.slice(1);
    const commands = fs.readFileSync(commandLogPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const summary = {
      ok: okValue === "true",
      failedStep: failedStep || null,
      failureMessage: failureMessage || null,
      commands,
      cleanup: {
        createdIssueIds: JSON.parse(createdJson),
        closedIssueIds: JSON.parse(closedJson),
      },
      failureArtifact: summaryPath,
      artifactDir,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  ' "$(node_fs_path "${COMMAND_LOG_PATH}")" "$(node_fs_path "${SUMMARY_PATH}")" "${ok}" "${failed_step}" "${failure_message}" "$(node_fs_path "${ARTIFACT_DIR}")" "$(printf '%s\n' "${created_issue_ids[@]:-}" | "${NODE_CMD}" -e 'const fs=require("node:fs"); const lines=fs.readFileSync(0,"utf8").split(/\r?\n/).filter(Boolean); process.stdout.write(JSON.stringify(lines));')" "$(printf '%s\n' "${closed_issue_ids[@]:-}" | "${NODE_CMD}" -e 'const fs=require("node:fs"); const lines=fs.readFileSync(0,"utf8").split(/\r?\n/).filter(Boolean); process.stdout.write(JSON.stringify(lines));')"
}

run_bd_step() {
  local step="$1"
  local command_name="$2"
  shift 2

  local stdout_file stderr_file exit_code command_text
  stdout_file="${ARTIFACT_DIR}/$(printf '%s' "${step}" | tr '[:upper:]' '[:lower:]').stdout"
  stderr_file="${ARTIFACT_DIR}/$(printf '%s' "${step}" | tr '[:upper:]' '[:lower:]').stderr"
  command_text="$*"

  if "${BD_CMD}" "$@" >"${stdout_file}" 2>"${stderr_file}"; then
    exit_code=0
  else
    exit_code=$?
  fi

  append_command "${step}" "${command_name}" "${command_text}" "${exit_code}" "${stdout_file}" "${stderr_file}"

  if [[ "${exit_code}" -ne 0 ]]; then
    failed_step="${command_name}"
    local stderr_text stdout_text
    stderr_text="$(read_output_snippet "${stderr_file}")"
    stdout_text="$(read_output_snippet "${stdout_file}")"
    failure_message="${stderr_text:-${stdout_text:-${command_text}}}"
    return "${exit_code}"
  fi

  cat "${stdout_file}"
}

is_closed_issue() {
  local issue_id="$1"
  local existing
  for existing in "${closed_issue_ids[@]:-}"; do
    if [[ "${existing}" == "${issue_id}" ]]; then
      return 0
    fi
  done
  return 1
}

rollback_unclosed_issues() {
  local idx issue_id
  for (( idx=${#created_issue_ids[@]} - 1; idx>=0; idx-- )); do
    issue_id="${created_issue_ids[idx]}"
    if is_closed_issue "${issue_id}"; then
      continue
    fi
    if run_bd_step "rollback-close-${issue_id}" "close" close "${issue_id}" "--reason=${CLEANUP_REASON}" >/dev/null; then
      closed_issue_ids+=("${issue_id}")
    fi
  done
}

handle_issue_id_parse_failure() {
  local issue_title="$1"
  local message="$2"
  local recovered_issue_id=""

  failed_step="create"
  failure_message="${message}"

  recovered_issue_id="$(find_issue_id_by_title "${issue_title}" || true)"
  if [[ -n "${recovered_issue_id}" ]]; then
    created_issue_ids+=("${recovered_issue_id}")
  fi

  rollback_unclosed_issues
  write_summary "false"
  exit 1
}

primary_output="$(run_bd_step "create-primary" "create" create --title="${PRIMARY_ISSUE_TITLE}" --type=task --priority=4)" || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}
primary_issue_id="$(parse_issue_id "${primary_output}")" || {
  handle_issue_id_parse_failure "${PRIMARY_ISSUE_TITLE}" "Could not parse primary smoke issue ID"
}
created_issue_ids+=("${primary_issue_id}")

dependent_output="$(run_bd_step "create-dependent" "create" create --title="${DEPENDENT_ISSUE_TITLE}" --type=task --priority=4)" || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}
dependent_issue_id="$(parse_issue_id "${dependent_output}")" || {
  handle_issue_id_parse_failure "${DEPENDENT_ISSUE_TITLE}" "Could not parse dependent smoke issue ID"
}
created_issue_ids+=("${dependent_issue_id}")

run_bd_step "list" "list" list --json --limit=50 >/dev/null || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}

run_bd_step "show-primary" "show" show "${primary_issue_id}" --json >/dev/null || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}

run_bd_step "dep-add" "dep" dep add "${primary_issue_id}" "${dependent_issue_id}" >/dev/null || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}

run_bd_step "close-dependent" "close" close "${dependent_issue_id}" "--reason=${CLEANUP_REASON}" >/dev/null || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}
closed_issue_ids+=("${dependent_issue_id}")

run_bd_step "close-primary" "close" close "${primary_issue_id}" "--reason=${CLEANUP_REASON}" >/dev/null || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}
closed_issue_ids+=("${primary_issue_id}")

run_bd_step "sync" "sync" sync >/dev/null || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}

write_summary "true"
printf '%s\n' "${SUMMARY_PATH}"
