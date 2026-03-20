import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const planPath = join(import.meta.dir, '..', '..', '.claude', 'commands', 'plan.md');
const planContent = readFileSync(planPath, 'utf-8');

describe('/plan phase tracking', () => {
  test('bd create appears BEFORE Phase 1 Q&A section (in Entry HARD-GATE area)', () => {
    const bdCreateIndex = planContent.indexOf('bd create --title=');
    const phase1HeadingIndex = planContent.indexOf('## Phase 1: Design Intent');

    expect(bdCreateIndex).not.toBe(-1);
    expect(phase1HeadingIndex).not.toBe(-1);
    expect(bdCreateIndex).toBeLessThan(phase1HeadingIndex);
  });

  test('bd create uses --type=epic (not --type=feature)', () => {
    // The early creation should be an epic
    const entryGateEnd = planContent.indexOf('## Phase 1: Design Intent');
    const entrySection = planContent.slice(0, entryGateEnd);

    expect(entrySection).toMatch(/bd create\b.*--type=epic/);
  });

  test('stage-transition with "none plan" appears at Phase 1 entry', () => {
    const phase1Index = planContent.indexOf('## Phase 1: Design Intent');
    const entrySection = planContent.slice(0, phase1Index);

    expect(entrySection).toMatch(/stage-transition\s+<id>\s+none\s+plan/);
  });

  test('stage-transition with "plan research" appears at Phase 2 entry', () => {
    const phase2Index = planContent.indexOf('## Phase 2: Technical Research');
    const phase2End = planContent.indexOf('<HARD-GATE: Phase 2 exit>');
    const phase2Section = planContent.slice(phase2Index, phase2End);

    // Should appear near the start of Phase 2, before research begins
    expect(phase2Section).toMatch(/stage-transition\s+<id>\s+plan\s+research/);
  });

  test('stage-transition with "research setup" appears at Phase 3 entry', () => {
    const phase3Index = planContent.indexOf('## Phase 3: Setup + Task List');
    const phase3Step1Index = planContent.indexOf('### Step 1:', phase3Index);
    const phase3EntrySection = planContent.slice(phase3Index, phase3Step1Index);

    expect(phase3EntrySection).toMatch(/stage-transition\s+<id>\s+research\s+setup/);
  });

  test('Phase 3 Step 1 references linking to epic, not creating a new issue', () => {
    const phase3Index = planContent.indexOf('## Phase 3: Setup + Task List');
    const step2Index = planContent.indexOf('### Step 2:', phase3Index);
    const step1Section = planContent.slice(phase3Index, step2Index);

    // Should NOT have a standalone bd create for the main epic (without --parent)
    expect(step1Section).not.toMatch(/bd create\b.*--type=epic/);

    // Any bd create in Step 1 should use --parent (child issue linking)
    const step1Creates = step1Section.match(/bd create\b[^\n]*/g);
    if (step1Creates) {
      for (const match of step1Creates) {
        expect(match).toContain('--parent');
      }
    }

    // Should reference linking child issues to the epic
    expect(step1Section).toMatch(/epic/i);
  });

  test('bd create in Phase 3 is for child issues (--parent), not the main epic', () => {
    const phase3Index = planContent.indexOf('## Phase 3: Setup + Task List');
    const phase3Content = planContent.slice(phase3Index);

    // Phase 3 should NOT have a standalone bd create --type=epic
    expect(phase3Content).not.toMatch(/bd create\b.*--type=epic/);

    // Any bd create in Phase 3 should reference --parent (linking to epic)
    const bdCreateMatches = phase3Content.match(/bd create\b[^\n]*/g);
    if (bdCreateMatches) {
      for (const match of bdCreateMatches) {
        expect(match).toContain('--parent');
      }
    }
  });
});
