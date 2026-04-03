# Agent Plugins

This directory contains plugin definitions for all supported AI coding agents.

## Plugin Architecture

Each agent is defined by a JSON file following the plugin schema. This allows:
- **Discoverability**: New agents can be added without modifying core code
- **Community contributions**: Anyone can add support for new agents
- **Backwards compatibility**: Existing functionality remains unchanged
- **Maintainability**: Agent configurations are separated from business logic

## Plugin Schema

Each plugin file must follow this structure:

```json
{
  "id": "agent-id",           // REQUIRED: Unique identifier (lowercase, alphanumeric, hyphens)
  "name": "Agent Name",       // REQUIRED: Human-readable name
  "version": "1.0.0",         // REQUIRED: Semantic version (x.y.z)
  "description": "...",       // OPTIONAL: Brief description
  "homepage": "https://...",  // OPTIONAL: Agent's homepage URL
  "capabilities": {           // OPTIONAL: Agent capabilities
    "commands": true,         // Supports commands
    "rules": true,            // Supports rules/instructions
    "skills": true,           // Supports skills
    "mcp": true,              // Supports MCP servers
    "contextMode": true,      // Supports context isolation/modes
    "hooks": {                // Supports hooks and blocking hooks
      "blocking": false
    }
  },
  "support": {                // OPTIONAL: Support quality metadata
    "status": "supported",    // first-class | supported | compatibility | deprecated | unsupported
    "surface": "cli-first",   // cli-first | editor-native | desktop-app | web-app | terminal-native | hybrid
    "install": {
      "required": true,       // Requires installation or setup
      "repairRequired": false  // Can be repaired in place instead of reinstalled
    }
  },
  "directories": {            // REQUIRED: Directory structure (at least one)
    "commands": ".your-agent/commands",
    "rules": ".your-agent/rules",
    "skills": ".your-agent/skills/forge-workflow",
    "scripts": ".your-agent/scripts"
  },
  "files": {                  // OPTIONAL: Important file paths
    "rootConfig": "YOUR-AGENT.md",
    "skillDefinition": ".your-agent/skills/forge-workflow/SKILL.md"
  },
  "setup": {                  // OPTIONAL: Setup instructions
    "copyCommands": true,
    "copyRules": true,
    "createSkill": true,
    "customSetup": "agent-name",
    "needsConversion": false
  }
}
```

### Required Fields

- **id**: Unique identifier for the agent (must match filename without `.plugin.json`)
- **name**: Display name shown to users
- **version**: Semantic version number (major.minor.patch)
- **directories**: Object with at least one directory path

### Optional Fields

- **description**: Short description of the agent
- **homepage**: URL to agent's official website
- **capabilities**: Object defining what the agent supports
- **support**: Support tier and enforcement metadata
- **files**: Important configuration file paths
- **setup**: Installation and setup instructions

### Normalized Capability Metadata

`PluginManager` exposes a normalized capability block on each loaded plugin at `normalizedCapabilities`:

- `nativeSurface`
- `supportStatus`
- `commands`
- `rules`
- `skills`
- `mcp`
- `contextMode`
- `hooks.blocking`
- `install.required`
- `install.repairRequired`

Legacy `capabilities.hooks: true/false` values are still accepted and normalized to `hooks.blocking`.

## Supported Agents

Currently supported AI coding agents:

| Agent | ID | Description |
|-------|----|-----------|
| Claude Code | `claude` | Anthropic's CLI agent |
| Cursor | `cursor` | AI-first code editor |
| Kilo Code | `kilocode` | VS Code extension |
| GitHub Copilot | `copilot` | GitHub's AI assistant |
| OpenCode | `opencode` | Open-source agent |
| Cline | `cline` | VS Code agent extension |
| Roo Code | `roo` | Cline fork with modes |

## Adding a New Agent

To add support for a new AI coding agent:

1. **Create plugin file**: `lib/agents/your-agent.plugin.json`
2. **Follow schema**: Use the template below or copy an existing plugin
3. **Validate**: Run tests to ensure your plugin is valid
4. **Test**: Run `bunx forge setup --agents your-agent` to verify
5. **Submit PR**: Contribute back to the community!

### Plugin Template

See `.github/PLUGIN_TEMPLATE.json` for a ready-to-use template.

```json
{
  "id": "your-agent",
  "name": "Your Agent Name",
  "version": "1.0.0",
  "description": "Brief description of your agent",
  "homepage": "https://your-agent.example.com",
  "capabilities": {
    "commands": true,
    "skills": true,
    "hooks": false
  },
  "directories": {
    "rules": ".your-agent/rules",
    "skills": ".your-agent/skills/forge-workflow"
  },
  "files": {
    "rootConfig": ".your-agent-rules"
  },
  "setup": {
    "createSkill": true
  }
}
```

## Validation

The PluginManager automatically validates all plugins on load:

- **Schema validation**: Required fields must be present
- **Type checking**: Fields must have correct types
- **Unique IDs**: No duplicate plugin IDs allowed
- **JSON syntax**: Files must be valid JSON
- **Support metadata**: `support.status` must be one of `first-class`, `supported`, `compatibility`, `deprecated`, or `unsupported`
- **Capability metadata**: `capabilities.hooks.blocking`, `capabilities.mcp`, `capabilities.contextMode`, and the other support flags must be booleans when present

Run tests to validate your plugin:

```bash
bun test test/plugins/
```

## Community Contributions

We welcome community contributions for new AI coding agents!

**Before submitting:**
1. Ensure your plugin passes all validation tests
2. Test the agent setup with `bunx forge setup --agents your-agent`
3. Document any special setup requirements
4. Follow the existing plugin structure

**PR Guidelines:**
- One plugin per PR
- Include plugin JSON file only (no code changes needed)
- Update this README with agent information
- Test that all existing tests still pass

## Technical Details

### Plugin Loading

The `PluginManager` class (`lib/plugin-manager.js`) handles:
- Auto-discovery of `.plugin.json` files in this directory
- Schema validation for each plugin
- Conversion to internal AGENTS format (backwards compatibility)
- Error handling for invalid plugins

### Backwards Compatibility

Plugins are automatically converted to the legacy AGENTS object structure:

```javascript
{
  name: plugin.name,
  description: plugin.description,
  dirs: Object.values(plugin.directories),
  hasCommands: plugin.capabilities?.commands,
  hasSkill: plugin.capabilities?.skills,
  // ... other fields
}
```

This ensures existing code continues to work without modifications.

## Troubleshooting

### Plugin Not Loading

If your plugin isn't appearing in `bunx forge setup`:

1. **Check filename**: Must end with `.plugin.json`
2. **Validate JSON**: Ensure file is valid JSON (no trailing commas, quotes correct)
3. **Check required fields**: id, name, version, directories must be present
4. **Run tests**: `bun test test/plugins/` will show specific errors
5. **Check logs**: Any loading errors will be displayed

### Schema Validation Errors

Common validation errors:

- `missing required field "id"`: Add the id field
- `"directories" must be an object`: Ensure directories is an object, not array
- `"version" must be a string`: Version must be in "x.y.z" format
- `"support.status" must be one of ...`: Use a supported status value
- `Plugin with ID "x" already exists`: Choose a unique ID

## License

All plugin definitions in this directory are MIT licensed, same as the Forge project.
