const { describe, test, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const planPath = join(__dirname, '..', '..', 'skills', 'plan', 'SKILL.md');
const planContent = readFileSync(planPath, 'utf-8');

describe('/plan phase tracking', () => {
  test('forge create appears BEFORE Phase 1 Q&A section (in Entry HARD-GATE area)', () => {
    const createIndex = planContent.indexOf('forge create --title=');
    const phase1HeadingIndex = planContent.indexOf('## Phase 1: Design Intent');

    expect(createIndex).not.toBe(-1);
    expect(phase1HeadingIndex).not.toBe(-1);
    expect(createIndex).toBeLessThan(phase1HeadingIndex);
  });

  test('forge create uses --type=epic (not --type=feature)', () => {
    // The early creation should be an epic
    const entryGateEnd = planContent.indexOf('## Phase 1: Design Intent');
    const entrySection = planContent.slice(0, entryGateEnd);

    expect(entrySection).toMatch(/forge create\b.*--type=epic/);
  });

  // Stage transitions are recorded kernel-natively via `forge comment "Stage: X → Y"`
  // (the legacy beads-context.sh stage-transition helper was removed from this skill).
  test('none→plan transition recorded via forge comment at Phase 1 entry', () => {
    const phase1Index = planContent.indexOf('## Phase 1: Design Intent');
    const entrySection = planContent.slice(0, phase1Index);

    expect(entrySection).toMatch(/forge comment[^\n]*none[^\n]*plan/i);
    expect(entrySection).not.toContain('beads-context.sh');
  });

  test('plan→research transition recorded via forge comment at Phase 2 entry', () => {
    const phase2Index = planContent.indexOf('## Phase 2: Technical Research');
    const phase2End = planContent.indexOf('<HARD-GATE: Phase 2 exit>');
    const phase2Section = planContent.slice(phase2Index, phase2End);

    // Should appear near the start of Phase 2, before research begins
    expect(phase2Section).toMatch(/forge comment[^\n]*plan[^\n]*research/i);
    expect(phase2Section).not.toContain('beads-context.sh');
  });

  test('research→setup transition recorded via forge comment at Phase 3 entry', () => {
    const phase3Index = planContent.indexOf('## Phase 3: Setup + Task List');
    const phase3Step1Index = planContent.indexOf('### Step 1:', phase3Index);
    const phase3EntrySection = planContent.slice(phase3Index, phase3Step1Index);

    expect(phase3EntrySection).toMatch(/forge comment[^\n]*research[^\n]*setup/i);
    expect(phase3EntrySection).not.toContain('beads-context.sh');
  });

  test('Phase 3 Step 1 references linking to epic, not creating a new issue', () => {
    const phase3Index = planContent.indexOf('## Phase 3: Setup + Task List');
    const step2Index = planContent.indexOf('### Step 2:', phase3Index);
    const step1Section = planContent.slice(phase3Index, step2Index);

    // Should NOT have a standalone forge create for the main epic (without --parent)
    expect(step1Section).not.toMatch(/forge create\b.*--type=epic/);

    // Any forge create in Step 1 should use --parent (child issue linking)
    const step1Creates = step1Section.match(/forge create\b[^\n]*/g);
    if (step1Creates) {
      for (const match of step1Creates) {
        expect(match).toContain('--parent');
      }
    }

    // Should reference linking child issues to the epic
    expect(step1Section).toMatch(/epic/i);
  });

  test('forge create in Phase 3 is for child issues (--parent), not the main epic', () => {
    const phase3Index = planContent.indexOf('## Phase 3: Setup + Task List');
    const phase3Content = planContent.slice(phase3Index);

    // Phase 3 should NOT have a standalone forge create --type=epic
    expect(phase3Content).not.toMatch(/forge create\b.*--type=epic/);

    // Any forge create in Phase 3 should reference --parent (linking to epic)
    const createMatches = phase3Content.match(/forge create\b[^\n]*/g);
    if (createMatches) {
      for (const match of createMatches) {
        expect(match).toContain('--parent');
      }
    }
  });
});
