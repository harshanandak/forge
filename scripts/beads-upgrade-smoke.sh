#!/usr/bin/env bash
set -euo pipefail

BD_CMD="${BD_CMD:-bd}"
NODE_CMD="${NODE_CMD:-node}"
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
ARTIFACT_DIR="${BEADS_UPGRADE_SMOKE_ARTIFACT_DIR:-${PROJECT_ROOT}/.artifacts/beads-upgrade-smoke}"
COMMAND_LOG_PATH="${ARTIFACT_DIR}/commands.jsonl"
SUMMARY_PATH="${ARTIFACT_DIR}/summary.json"
CLEANUP_REASON="Beads upgrade smoke cleanup"

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
  return 1
}

append_command() {
  local step="$1"
  local command_name="$2"
  local command_text="$3"
  local exit_code="$4"
  local stdout_text="$5"
  local stderr_text="$6"

  "${NODE_CMD}" -e '
    const fs = require("node:fs");
    const [logPath, step, commandName, commandText, exitCode, stdoutText, stderrText] = process.argv.slice(1);
    const entry = {
      step,
      commandName,
      commandText,
      exitCode: Number(exitCode),
      stdout: stdoutText,
      stderr: stderrText,
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  ' "${COMMAND_LOG_PATH}" "${step}" "${command_name}" "${command_text}" "${exit_code}" "${stdout_text}" "${stderr_text}"
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
  ' "${COMMAND_LOG_PATH}" "${SUMMARY_PATH}" "${ok}" "${failed_step}" "${failure_message}" "${ARTIFACT_DIR}" "$(printf '%s\n' "${created_issue_ids[@]:-}" | "${NODE_CMD}" -e 'const fs=require("node:fs"); const lines=fs.readFileSync(0,"utf8").split(/\r?\n/).filter(Boolean); process.stdout.write(JSON.stringify(lines));')" "$(printf '%s\n' "${closed_issue_ids[@]:-}" | "${NODE_CMD}" -e 'const fs=require("node:fs"); const lines=fs.readFileSync(0,"utf8").split(/\r?\n/).filter(Boolean); process.stdout.write(JSON.stringify(lines));')"
}

run_bd_step() {
  local step="$1"
  local command_name="$2"
  shift 2

  local stdout_file stderr_file exit_code stdout_text stderr_text command_text
  stdout_file="${ARTIFACT_DIR}/$(printf '%s' "${step}" | tr '[:upper:]' '[:lower:]').stdout"
  stderr_file="${ARTIFACT_DIR}/$(printf '%s' "${step}" | tr '[:upper:]' '[:lower:]').stderr"
  command_text="$*"

  if "${BD_CMD}" "$@" >"${stdout_file}" 2>"${stderr_file}"; then
    exit_code=0
  else
    exit_code=$?
  fi

  stdout_text="$(cat "${stdout_file}" 2>/dev/null || true)"
  stderr_text="$(cat "${stderr_file}" 2>/dev/null || true)"
  append_command "${step}" "${command_name}" "${command_text}" "${exit_code}" "${stdout_text}" "${stderr_text}"

  if [[ "${exit_code}" -ne 0 ]]; then
    failed_step="${command_name}"
    failure_message="${stderr_text:-${stdout_text:-${command_text}}}"
    return "${exit_code}"
  fi

  printf '%s' "${stdout_text}"
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

primary_output="$(run_bd_step "create-primary" "create" create --title="Beads upgrade smoke primary" --type=task --priority=4)" || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}
primary_issue_id="$(parse_issue_id "${primary_output}")" || {
  failed_step="create"
  failure_message="Could not parse primary smoke issue ID"
  write_summary "false"
  exit 1
}
created_issue_ids+=("${primary_issue_id}")

dependent_output="$(run_bd_step "create-dependent" "create" create --title="Beads upgrade smoke dependent" --type=task --priority=4)" || {
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}
dependent_issue_id="$(parse_issue_id "${dependent_output}")" || {
  failed_step="create"
  failure_message="Could not parse dependent smoke issue ID"
  rollback_unclosed_issues
  write_summary "false"
  exit 1
}
created_issue_ids+=("${dependent_issue_id}")

run_bd_step "list" "list" list --json --limit=0 >/dev/null || {
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
