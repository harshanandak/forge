# Forge Setup - AI Agent Installation Prompt

**For AI Agents**: This is a step-by-step guide to help you install Forge workflow in the user's project. Follow these instructions carefully to ensure proper setup.

---

## Your Task

Help the user install Forge - a TDD-first development workflow system. You will:
1. Detect project context (framework, language, CI/CD)
2. Run installation command
3. Verify setup
4. Guide the user on next steps

---

## Step 1: Detect Agent Type

First, determine which AI agent you are by checking for these directories:

```bash
# Check for agent-specific directories
ls -la | grep -E "\.claude|\.cursor|\.cline|\.continue"
```

**Agent Detection:**
- `.claude/` exists → You are **Claude Code**
- `.cursor/` exists → You are **Cursor**
- `.cline/` exists → You are **Cline**
- `.continue/` exists → You are **Continue**
- None exist → Generic agent

Store this for later: `DETECTED_AGENT=<name>`

---

## Step 2: Gather Project Context

Explore the project to understand its structure:

### Framework Detection
```bash
# Check package.json for framework
cat package.json | grep -E "next|react|vue|express|fastify"
```

### Language Detection
```bash
# Check for TypeScript
ls | grep -E "tsconfig.json"
# Check package.json devDependencies
cat package.json | grep typescript
```

### CI/CD Detection
```bash
# Check for CI/CD systems
ls -la .github/workflows/
ls -la .gitlab-ci.yml
```

### Git Statistics
```bash
# Check project maturity
git rev-list --count HEAD  # Commit count
git tag                     # Releases
```

**Store findings:**
- Framework: `<Next.js|React|Vue|Express|Unknown>`
- Language: `<typescript|javascript>`
- CI/CD: `<GitHub Actions|GitLab CI|None>`
- Commits: `<count>`
- Stage: `<new|active|stable>` (based on commits)

---

## Step 3: Ask User Questions (Optional)

If auto-detection has low confidence, ask the user:

**Core Questions (3):**
1. "What is this project about in one sentence?"
2. "What are you currently working on?"
3. "Confirm detected project stage: `<detected>`?"

**Optional Questions (only if needed):**
4. "Primary programming language?"
5. "Main framework/tech stack?"

---

## Step 4: Run Installation

Execute the Forge setup command with detected agent:

```bash
bunx forge setup --agents $DETECTED_AGENT
```

**Expected Output:**
- `AGENTS.md` created or updated
- `.forge/context.json` created with auto-detected info
- Instructions displayed for next steps

**If command fails:**
- Check Node.js version: `node --version` (need v18+)
- Try with bunx: `bunx forge@latest setup --agents $DETECTED_AGENT`
- Report error to user with instructions to check `https://github.com/your-repo/issues`

---

## Step 5: Verify Setup

Check that files were created properly:

```bash
# Verify core files exist
test -f AGENTS.md && echo "✓ AGENTS.md created"
test -f .forge/context.json && echo "✓ Context saved"

# Show what was created
cat .forge/context.json
```

**Expected context.json structure:**
```json
{
  "auto_detected": {
    "framework": "Next.js",
    "language": "typescript",
    "stage": "active",
    "confidence": 0.85
  },
  "user_provided": {
    "description": "...",
    "current_work": "..."
  }
}
```

---

## Step 6: Customize AGENTS.md (Optional Enhancement)

If you gathered rich context in Step 2, enhance the generated AGENTS.md:

### Add Project-Specific Sections

Look for the `<!-- USER:START -->` marker and add:

```markdown
## Project Context

**Framework**: Next.js 14 with App Router
**Language**: TypeScript (strict mode)
**Database**: PostgreSQL with Prisma ORM
**Testing**: Jest + React Testing Library
**CI/CD**: GitHub Actions (main branch protected)

## Architecture Notes

- Frontend: React Server Components
- API: Next.js API routes + tRPC
- Auth: NextAuth.js with JWT sessions
```

**IMPORTANT:**
- Only add facts discovered during exploration
- Do NOT make up information
- Keep additions inside `<!-- USER:START -->` / `<!-- USER:END -->` markers

---

## Step 7: Report Results

Summarize what was completed for the user:

```
✅ Forge Installation Complete

**What was created:**
- AGENTS.md: Workflow configuration for AI agents
- .forge/context.json: Project context storage

**Auto-detected:**
- Framework: <detected-framework>
- Language: <detected-language>
- Stage: <detected-stage>

**Next Steps:**

1. Review AGENTS.md to understand the workflow
2. Run `/status` to see current project state
3. Start your first task:
   - Feature: `/research <feature-name>` → `/plan` → `/dev`
   - Bug fix: `/dev` (write failing test first)
   - Docs: `/verify` → `/ship`

**Quick Start Commands:**
- `/status` - Check current context
- `/research <topic>` - Research with web search
- `/plan <feature-slug>` - Create implementation plan
- `/dev` - Start TDD development

**Need help?** Check docs/WORKFLOW.md for full guide
```

---

## Step 8: Offer to Run /status

Ask the user:

> "Would you like me to run `/status` now to check the project state and show you what's available to work on?"

If yes → Run the `/status` skill/command

---

## Safety Guardrails

**DO:**
- ✅ Read files to understand project structure
- ✅ Run safe commands (ls, cat, grep, git status)
- ✅ Ask user for confirmation before installation
- ✅ Verify files were created successfully
- ✅ Report what changed

**DON'T:**
- ❌ Run destructive commands (rm, mv, git reset)
- ❌ Modify existing files without asking
- ❌ Push to remote repositories
- ❌ Make up project information
- ❌ Skip verification steps

---

## Troubleshooting

### Installation Fails

**Error: "Command not found: npx"**
- Solution: Install Node.js v18+ from https://nodejs.org/

**Error: "AGENTS.md already exists"**
- Solution: Offer user options:
  1. Intelligent merge (preserves their content)
  2. Keep existing (skip installation)
  3. Backup and replace

```bash
# Backup existing file
cp AGENTS.md AGENTS.md.backup
# Then retry installation
bunx forge setup --merge=smart --agents $DETECTED_AGENT
```

**Error: "Permission denied"**
- Solution: Check write permissions in directory

### Context Detection Issues

**Low confidence (<0.6)**
- Ask user the 3 core questions
- Document answers in `.forge/context.json` manually:

```bash
# Update context with user input
cat > .forge/context.json <<EOF
{
  "user_provided": {
    "description": "<user-answer-1>",
    "current_work": "<user-answer-2>"
  }
}
EOF
```

---

## Example Full Conversation

**User:** "I want to set up Forge in my project"

**Agent (You):**

> I'll help you set up Forge! Let me first explore your project to understand its structure.
>
> *[Runs detection commands...]*
>
> I detected:
> - Framework: **Next.js**
> - Language: **TypeScript**
> - CI/CD: **GitHub Actions**
> - Stage: **Active** (150 commits, CI/CD configured)
> - Agent: **Claude Code** (detected from .claude/ directory)
>
> This looks correct?

**User:** "Yes"

**Agent:**

> Great! Running installation...
>
> *[Executes: `bunx forge setup --agents claude-code`]*
>
> ✅ **Installation Complete!**
>
> Created:
> - `AGENTS.md` - Your workflow configuration
> - `.forge/context.json` - Project context storage
>
> **Next steps:**
> 1. Review AGENTS.md to understand the workflow
> 2. Try `/status` to see current project state
>
> Would you like me to run `/status` now?

---

## Notes for AI Agents

- **Be conversational**: This is an interactive process, not a script
- **Show progress**: Use emojis (✅, 🔍, ⚙️) to make it engaging
- **Ask when unsure**: Better to ask than guess wrong
- **Verify everything**: Don't assume - check that files were created
- **Be helpful**: Offer to run `/status` or create first issue

**This prompt is designed to work with:**
- Claude Code (via CLI)
- Cursor (via chat)
- Cline (via VSCode extension)
- Continue (via VSCode extension)
- Any AI coding assistant with file system access

---

## Version

**Forge Setup Prompt v1.6.0**
Last updated: 2026-02-06

For issues or improvements, report at: https://github.com/your-repo/issues
