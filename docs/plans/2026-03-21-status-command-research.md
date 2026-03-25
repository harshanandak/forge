# Smart CLI Status Command — Deep Research Report

**Date**: 2026-03-21
**Purpose**: Research findings for building a priority-ranked CLI status command

---

## 1. CLI Status Dashboard Patterns

### Taskwarrior's `next` Report
The gold standard. Displays tasks sorted by decreasing urgency score. Each row shows ID, age, dependencies, project, tags, due date, description, and urgency score. The urgency column is the sort key — a computed float that combines ~14 weighted factors.

### Linear CLI
Linear uses a fixed 5-level priority system: Urgent, High, Medium, Low, No Priority. Position within a priority level is saved globally via drag-and-drop, so all workspace users see the same relative ordering. Multiple CLI implementations exist (schpet/linear-cli, AdiKsOnDev/linear-cli, megalath/Linear-CLI) supporting filtering by status/assignee/labels/teams and output in JSON/CSV/YAML.

### GitHub CLI (`gh issue list`)
Supports `--label`, `--assignee`, `--state` filters. Sorting is done via `--search` with GitHub search syntax (e.g., `sort:created-asc`). Supports `--json` for machine-readable output with fields like labels, projectItems, milestone. No built-in priority scoring — relies on label-based priority.

### Common Grouping Strategies
- **By priority level** (Linear, Jira): Fixed tiers, items ordered within tiers
- **By computed score** (Taskwarrior): Single numeric score, flat sorted list
- **By status/workflow state** (Linear, GitHub): Columns or sections per state
- **By project/epic** then priority within group

**Sources:**
- https://taskwarrior.org/docs/urgency/
- https://linear.app/docs/priority
- https://cli.github.com/manual/gh_issue_list
- https://github.com/schpet/linear-cli
- https://github.com/AdiKsOnDev/linear-cli

---

## 2. Issue Prioritization Algorithms

### Taskwarrior Urgency Formula (Reference Implementation)

A polynomial (weighted sum of terms). Each term = coefficient x factor_value.

**Default Coefficients:**

| Factor | Coefficient | Notes |
|--------|------------|-------|
| `+next` tag | 15.0 | Manually flagged "do next" |
| Due date proximity | 12.0 | Piecewise ramp (see aging section) |
| Blocking other tasks | 8.0 | Has dependents |
| Priority High | 6.0 | |
| Priority Medium | 3.9 | |
| Priority Low | 1.8 | |
| Scheduled | 5.0 | Has a scheduled date |
| Active (started) | 4.0 | Already in progress |
| Age | 2.0 | Linear ramp to max (see aging section) |
| Annotations | 1.0 | Modified: 0.8 for 1, 0.9 for 2, 1.0 for 3+ |
| Tags | 1.0 | Binary: 1.0 if any tag present, 0.0 if none |
| Project assigned | 1.0 | Belongs to any project |
| Waiting | -3.0 | Negative — deprioritize |
| Blocked | -5.0 | Negative — can't work on it |

**Formula:** `urgency = SUM(coefficient_i * factor_i)`

**Design insight:** No single term should dominate. Taskwarrior docs explicitly warn against setting one coefficient to 30.0 while others are under 10.0, as it reduces the system to a single-factor sort.

### RICE Framework (Product Management)
`Score = (Reach x Impact x Confidence) / Effort`

Used in product tools like Productboard. Good for feature prioritization but less applicable to developer task lists.

### Weighted Scoring Model (General)
Assign weights to criteria (strategic alignment, risk, ROI, urgency, dependencies), score each item 1-5 per criterion, multiply and sum. Flexible but requires manual scoring.

**Sources:**
- https://taskwarrior.org/docs/urgency/
- https://taskwarrior.org/docs/priority/
- https://www.6sigma.us/six-sigma-in-focus/weighted-scoring-prioritization/
- https://roadmunk.com/product-management-blog/weighted-scoring-model/

---

## 3. Dependency Chain Impact Scoring

### Taskwarrior's Approach
- `urgency.blocking.coefficient = 8.0` — flat bonus for any task that blocks others
- `urgency.blocked.coefficient = -5.0` — penalty for blocked tasks
- `urgency.inherit` setting: when enabled, blocking tasks **recursively inherit** the highest urgency from their entire downstream chain. Recommended to set blocking/blocked coefficients to 0.0 when using inherit mode.

**Limitation identified by community:** The current system only checks BLOCKED/BLOCKING boolean flags. It does NOT count how many tasks are blocked. A task blocking 10 others gets the same +8.0 as a task blocking 1. This was raised in Discussion #2492.

### Proposed "Blast Radius" / Downstream Impact Score
Count the number of **transitive dependents** (all tasks reachable downstream in the dependency DAG). Weight by:

```
impact_score = direct_dependents * W1 + transitive_dependents * W2
```

Or use a recursive accumulation:
```
impact(task) = 1 + SUM(impact(dependent)) for each direct dependent
```

This gives tasks at the root of deep chains much higher scores than leaf tasks.

### Critical Path Method (CPM)
- Identify the **longest path** through the dependency graph (the critical path)
- Tasks on the critical path get priority — any delay on them delays the whole project
- Tasks NOT on the critical path have "float" (slack time)
- For a CLI status command: mark critical-path items with a visual indicator

### Topological Sort for Ordering
- Kahn's algorithm (BFS, uses in-degree): naturally surfaces tasks with zero dependencies first
- Can use a **priority queue** instead of a regular queue in Kahn's to combine topological order with priority scoring
- This gives "what can I work on NOW, ranked by importance"

**Sources:**
- https://github.com/GothenburgBitFactory/taskwarrior/discussions/2492
- https://github.com/GothenburgBitFactory/taskwarrior/issues/333
- https://count.co/metric/task-dependency-mapping
- https://en.wikipedia.org/wiki/Topological_sorting
- https://www.projectmanager.com/guides/critical-path-method

---

## 4. Terminal Output Formatting for Ranked Lists

### Color Coding Best Practices
- Use ANSI escape sequences (`\033[31m` for red, etc.)
- Prefer **8-bit extended colors** (`\033[38;5;Nm`) for cross-terminal consistency
- Always define foreground when setting background (light/dark theme compatibility)
- Respect `NO_COLOR` env var (https://no-color.org/) and detect TTY before emitting colors
- Use colors **semantically**: red for urgent/errors, yellow for warnings, green for good/done, dim/gray for low priority

### Alignment and Layout
- Use fixed-width columns with padding, not tabs (tabs misalign with non-ASCII)
- Right-align numeric scores for easy scanning
- Left-align text fields (titles, descriptions)
- Truncate long text with ellipsis to maintain column alignment
- Group items with section headers and blank-line separators

### Recommended Display Patterns

**Ranked list with score bar:**
```
  #  Score  Title                          Status
  1  [====] Fix auth bypass                critical
  2  [=== ] Add rate limiting              in-progress
  3  [==  ] Update dependencies            ready
  4  [=   ] Improve error messages         backlog
```

**Grouped by category with inline priority:**
```
BLOCKING (3 items)
  12.4  Fix auth bypass           [blocks 5 tasks]
   9.1  Database migration        [blocks 2 tasks]

READY TO START (4 items)
   7.3  Add rate limiting
   5.2  Update dependencies
```

### Machine-Readable Output
- Support `--json` flag for piping to `jq`
- Support `--plain` for tab-separated, no-color output
- Human-readable is the default when stdout is a TTY

**Sources:**
- https://clig.dev/ (Command Line Interface Guidelines — comprehensive)
- https://bettercli.org/design/using-colors-in-cli/
- https://lucasfcosta.com/2022/06/01/ux-patterns-cli-tools.html
- https://cli.r-lib.org/articles/semantic-cli.html

---

## 5. Staleness / Aging in Task Management

### Taskwarrior's Age Coefficient

**Formula:** `age_urgency = coefficient * min(task_age_days / age_max, 1.0)`

**Defaults:**
- `urgency.age.coefficient = 2.0`
- `urgency.age.max = 365` (days)

**Behavior:**
- Linear ramp from 0 to `coefficient` over `age_max` days
- At 365 days old, a task contributes the full 2.0 urgency from age
- After 365 days, no further increase (capped)
- A 10-day-old task: `2.0 * (10/365) = 0.055` urgency from age

### Taskwarrior's Due Date Ramp

The due date factor uses a **piecewise linear ramp** over a 21-day window centered around the due date:

```
days_until_due >= 14 days away:     factor = 0.2  (minimal urgency)
days_until_due in [14, -7]:         factor = linear ramp from 0.2 to 1.0
days_until_due <= -7 (7+ overdue):  factor = 1.0  (maximum urgency)
```

The factor is then multiplied by the due coefficient (12.0), so:
- Far future task: `12.0 * 0.2 = 2.4` urgency from due date
- Due today: `12.0 * ~0.73 = 8.8` urgency
- 7+ days overdue: `12.0 * 1.0 = 12.0` urgency (max)

**Known limitation:** Beyond 7 days overdue, urgency plateaus. Community has requested continued escalation for very overdue tasks (Issue #3078).

### Alternative Decay/Boost Functions to Consider

1. **Logarithmic aging**: `coefficient * log(1 + age_days) / log(1 + age_max)` — fast initial boost, diminishing returns
2. **Exponential decay for staleness**: `base_priority * e^(-lambda * days_since_update)` — items not touched recently lose urgency (opposite of Taskwarrior's approach)
3. **Sigmoid/S-curve**: `coefficient / (1 + e^(-k*(age - midpoint)))` — slow start, rapid middle, plateau. Good for due date proximity where urgency should spike as deadline approaches.
4. **Stepped thresholds**: Discrete jumps at milestones (1 week, 2 weeks, 1 month) — simpler to reason about

### Design Decision: Age = Boost or Decay?
- **Taskwarrior approach (age = boost):** Old tasks float up. Prevents "forgotten task" problem.
- **Staleness approach (age = decay):** Old untouched tasks sink. Assumes if nobody worked on it, it's probably not important.
- **Hybrid:** Boost for first N days (task is aging, needs attention), then decay after M days without update (stale, probably deprioritize).

**Sources:**
- https://taskwarrior.org/docs/urgency/
- https://taskwarrior.org/docs/man/taskrc.5/
- https://github.com/GothenburgBitFactory/taskwarrior/issues/3078
- https://github.com/GothenburgBitFactory/taskwarrior/discussions/3137
- https://github.com/GothenburgBitFactory/taskwarrior/discussions/2492

---

## Key Takeaways for Implementation

1. **Use Taskwarrior's polynomial model as the foundation** — it's battle-tested, configurable, and well-understood. Adapt the coefficients for your domain.

2. **Improve on dependency scoring** — count transitive dependents (blast radius) rather than just boolean blocking/blocked. Consider `urgency.inherit` recursive propagation.

3. **Combine topological sort with priority** — use a priority-queue variant of Kahn's algorithm to show "actionable now, most important first."

4. **Aging should be a boost with a cap** — linear ramp to a max is simple and effective. Consider a hybrid where very stale items (no updates in 30+ days) get flagged differently.

5. **Terminal output: group then rank** — group by actionability (blocking/ready/blocked), rank within groups by score. Use color semantically. Support `--json` and `--plain`.

6. **Keep coefficients configurable** — what matters varies per project. Expose tuning without requiring source changes.
