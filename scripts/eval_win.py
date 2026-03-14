#!/usr/bin/env python3
"""Windows-compatible trigger evaluation for skill descriptions.

Tests whether a skill's description causes Claude to trigger (invoke the Skill
tool for) the REAL skill when processing a query. Skills must be discoverable
in .claude/skills/ for this to work.

Avoids select.select() (Unix-only on pipes) and ProcessPoolExecutor (crashes
on Windows with paging file errors). Runs queries sequentially using
subprocess.communicate().
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def parse_skill_md(skill_path: Path) -> tuple:
    """Parse a SKILL.md file, returning (name, description, full_content)."""
    content = (skill_path / "SKILL.md").read_text()
    lines = content.split("\n")

    if lines[0].strip() != "---":
        raise ValueError("SKILL.md missing frontmatter (no opening ---)")

    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        raise ValueError("SKILL.md missing frontmatter (no closing ---)")

    name = ""
    description = ""
    frontmatter_lines = lines[1:end_idx]
    i = 0
    while i < len(frontmatter_lines):
        line = frontmatter_lines[i]
        if line.startswith("name:"):
            name = line[len("name:"):].strip().strip('"').strip("'")
        elif line.startswith("description:"):
            value = line[len("description:"):].strip()
            if value in (">", "|", ">-", "|-"):
                continuation_lines = []
                i += 1
                while i < len(frontmatter_lines) and (
                    frontmatter_lines[i].startswith("  ")
                    or frontmatter_lines[i].startswith("\t")
                ):
                    continuation_lines.append(frontmatter_lines[i].strip())
                    i += 1
                description = " ".join(continuation_lines)
                continue
            else:
                description = value.strip('"').strip("'")
        i += 1

    return name, description, content


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .claude/."""
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def run_single_query(
    query: str,
    skill_name: str,
    timeout: int,
    project_root: str,
    model=None,
) -> bool:
    """Run a single query and return whether the REAL skill was triggered.

    Checks if Claude invokes the Skill tool with the skill's name.
    No temp command files — relies on .claude/skills/ discovery.
    """
    cmd = [
        "claude",
        "-p", query,
        "--output-format", "stream-json",
        "--verbose",
    ]
    if model:
        cmd.extend(["--model", model])

    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            cwd=project_root,
            env=env,
        )
        output = result.stdout.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return False

    # Parse output for skill triggering — check first assistant tool call only
    for line in output.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue

        # Check assistant message for Skill tool calls
        if event.get("type") == "assistant":
            message = event.get("message", {})
            for content_item in message.get("content", []):
                if content_item.get("type") != "tool_use":
                    continue
                tool_name = content_item.get("name", "")
                tool_input = content_item.get("input", {})
                if tool_name == "Skill":
                    invoked_skill = tool_input.get("skill", "")
                    if skill_name == invoked_skill:
                        return True
                    # Allow alias match only for known pairs
                    # (e.g., "sonarcloud" command triggers for "sonarcloud-analysis")
                    if (invoked_skill
                            and len(invoked_skill) >= 4
                            and invoked_skill == skill_name.split("-")[0]):
                        return True
                # First tool call that isn't our skill = not triggered
                return False

    return False


def main():
    parser = argparse.ArgumentParser(
        description="Windows-compatible trigger eval for skill descriptions"
    )
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--timeout", type=int, default=60, help="Timeout per query (s)")
    parser.add_argument("--runs-per-query", type=int, default=1, help="Runs per query")
    parser.add_argument(
        "--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold"
    )
    parser.add_argument("--model", default=None, help="Model override")
    parser.add_argument("--verbose", action="store_true", help="Print progress")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, description, _ = parse_skill_md(skill_path)
    project_root = find_project_root()

    if args.verbose:
        print(f"Skill: {name}", file=sys.stderr)
        print(f"Description: {description[:100]}...", file=sys.stderr)
        print(f"Project root: {project_root}", file=sys.stderr)
        print(f"Queries: {len(eval_set)}, Runs: {args.runs_per_query}", file=sys.stderr)
        print("", file=sys.stderr)

    results = []
    for idx, item in enumerate(eval_set):
        query = item["query"]
        should_trigger = item["should_trigger"]
        triggers = []

        for run_idx in range(args.runs_per_query):
            if args.verbose:
                print(
                    f"  [{idx+1}/{len(eval_set)}] run {run_idx+1}/{args.runs_per_query}: "
                    f"{query[:60]}...",
                    file=sys.stderr,
                )
            try:
                triggered = run_single_query(
                    query, name, args.timeout, str(project_root), args.model
                )
            except Exception as e:
                print(f"  Warning: {e}", file=sys.stderr)
                triggered = False
            triggers.append(triggered)

        trigger_rate = sum(triggers) / len(triggers) if triggers else 0.0
        if should_trigger:
            did_pass = trigger_rate >= args.trigger_threshold
        else:
            did_pass = trigger_rate < args.trigger_threshold

        results.append(
            {
                "query": query,
                "should_trigger": should_trigger,
                "trigger_rate": trigger_rate,
                "triggers": sum(triggers),
                "runs": len(triggers),
                "pass": did_pass,
            }
        )

        if args.verbose:
            status = "PASS" if did_pass else "FAIL"
            print(
                f"  [{status}] rate={sum(triggers)}/{len(triggers)} "
                f"expected={should_trigger}: {query[:70]}",
                file=sys.stderr,
            )

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    output = {
        "skill_name": name,
        "description": description,
        "results": results,
        "summary": {"total": total, "passed": passed, "failed": total - passed},
    }

    if args.verbose:
        print(f"\nResults: {passed}/{total} passed", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
