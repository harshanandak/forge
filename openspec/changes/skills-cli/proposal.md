# Proposal: Skills CLI Tool

## Problem

Skills (SKILL.md files) are scattered across multiple AI agent directories with no centralized management. Users must manually:
- Create SKILL.md files from scratch (hard, requires expertise)
- Copy skills to each agent directory (.claude/skills/, .cursor/skills/, .cline/skills/)
- Keep skills in sync across agents
- Share skills with others (no registry/marketplace)

**Pain points identified:**
- Skill creation is MANUAL and HARD (40+ rules for complex skills like React best practices)
- No discovery mechanism (users don't know what skills exist)
- No sharing mechanism (each user creates from scratch)
- Multi-agent management is tedious (copy-paste to 3+ directories)

## Solution

**Implement `@forge/skills` CLI** - Universal tool for managing SKILL.md files across all AI agents.

**Core capabilities:**
```bash
skills init                    # Initialize .skills/ registry
skills create my-skill         # Create from template (30-60s)
skills create --ai "..."       # AI-powered creation (v1.1) (15-30s)
skills list                    # Show all skills
skills sync                    # Sync to agent directories
skills add awesome-skill       # Install from Vercel registry
skills publish my-skill        # Publish to Vercel registry
skills search react            # Search Vercel registry
skills validate skill.md       # Validate format
```

**Architecture:**
1. `.skills/` = Canonical source (single source of truth)
2. Agent directories = Synced copies (.cursor/skills/, .github/skills/)
3. Vercel registry = Central marketplace (like npm for skills)

**Phased approach:**
- **v1.0 (6 weeks)**: Template-based CLI (matches Vercel's simplicity)
- **v1.1 (2 weeks)**: AI-powered creation (market differentiator)

## Alternatives Considered

### 1. Multi-Registry Architecture
**Rejected** - Added complexity, maintenance burden
- Would support Vercel + Forge + Custom registries
- User chose Vercel-only for simplicity

### 2. Symlink-based sync
**Rejected** - Windows compatibility issues
- Symlinks don't work reliably on Windows
- Copy-based sync is simple and universal (fs.cpSync)

### 3. AI-first approach
**Rejected** - Too slow for simple operations
- Every operation would require AI (15-30s wait)
- Users need speed for simple tasks (init, list, sync)
- Phased approach gives best of both worlds

### 4. Monolithic skill files in root
**Rejected** - Doesn't leverage existing agent integrations
- Agents already support .claude/skills/, .cursor/skills/
- Would require custom agent integration
- Better to work with existing standards

## Impact

### Benefits
- **Users**: Easier skill creation (templates + AI), discovery (registry), sharing (publish)
- **Forge ecosystem**: Matches Beads/OpenSpec integration pattern
- **Market**: First AI-powered skill creation tool (unmet need)

### Risks
- **Vercel registry dependency**: Mitigated by graceful fallback to local-only
- **Multi-agent compatibility**: Start with Cursor + Claude Code, expand later
- **Command injection**: Mitigated by using spawn (not exec)

### Success Metrics (v1.0)
- [ ] 100% test coverage for core commands
- [ ] Works on Unix/Linux/macOS/Windows
- [ ] Matches Vercel's feature set (competitive parity)
- [ ] Integrated with Forge setup (checkForSkills, initializeSkills)
- [ ] 5 skill templates included
- [ ] Vercel registry integration (publish, add, search)

### Success Metrics (v1.1)
- [ ] AI-powered creation generates production-ready skills
- [ ] Manager + Writer + Validator agent architecture working
- [ ] 5+ complex skill examples tested (e.g., "React best practices with 40+ rules")
- [ ] Market differentiation achieved (feature Vercel doesn't have)

## Implementation Timeline

**Total: 8 weeks**
- Weeks 1-2: Core CLI foundation (init, create, list, sync)
- Week 3: Local management (sync, remove, Windows compatibility)
- Week 4: Vercel registry integration (publish, add, search, auth)
- Week 5: Validation & quality (validate, schema checks)
- Week 6: Forge integration & polish (checkForSkills, AGENTS.md generation)
- Weeks 7-8: AI-powered creation (v1.1)

## Related Research

See `C:\Users\harsha_befach\.claude\plans\giggly-napping-stonebraker.md` for:
- Universal SKILL.md standard (YAML frontmatter + Markdown)
- Vercel's skills.sh architecture research
- Integration patterns from Beads and OpenSpec CLI tools
- Agent detection and sync strategies
- Security considerations (safe command execution)
