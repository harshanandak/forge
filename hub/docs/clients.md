# Connect a Forge hub client

Use a person bearer for MCP. Use a separate host key file for the Claude Code hooks. Load the bearer into the client's environment as `FORGE_HUB_TOKEN`.

Choose the hub URL from your deployment. For a local hub, use the numeric loopback address configured in `allowedHosts`, such as `http://127.0.0.1:3775` or `http://[::1]:3775`. Keep any configured base path. Set `FORGE_HUB_URL` to the base without a trailing slash or the `/mcp` suffix. Remote hook connections use HTTPS.

## Claude Code

Add this to the client MCP configuration. Claude Code expands the environment references.

```json
{
  "mcpServers": {
    "forge-hub": {
      "type": "http",
      "url": "${FORGE_HUB_URL}/mcp",
      "headers": { "Authorization": "Bearer ${FORGE_HUB_TOKEN}" }
    }
  }
}
```

When the hub's hooks are enabled, install the following hook settings. The `node` command on the hook host's PATH must be Node 24 or newer. Replace the placeholder with the absolute installation path. Keep the quotes around each script path.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"<absolute path>/bin/session-start.mjs\""
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<absolute path>/bin/pre-tool.mjs\"",
            "onFailure": "block"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"<absolute path>/bin/stop.mjs\""
          }
        ]
      }
    ]
  }
}
```

Set `FORGE_HUB_HOST_KEY_FILE` to the protected key file outside any repository or agent working directory. Use owner-only access (mode 0600 on POSIX). Leave all three hook entries out when hooks are disabled.

The PreToolUse setting requires Claude Code 2.1.295 or newer. The hooks are a local guard against accidental execution after an untrusted read. The server boundary checks person credentials and the named session's mode. An agent acting deliberately as the same OS user can access files its user can read, and the owner can remove the hooks. Codex and OpenCode do not provide this Forge fail-closed guard. While the hub is unavailable, the Claude guard still permits reads that resolve inside the working directory. Other tools need a fresh hub response.

SessionStart prints the registered Forge session id. Pass that `sessionId` to every Forge tool in the hooked session. Stop prefers the host's final assistant text. If that field is unavailable, the transcript fallback can lag behind the current turn.

For a forked Claude Code session (`source: "fork"`), SessionStart prints `Forge hub unavailable: INVALID_INPUT` and leaves the session unregistered.

## Codex

Use a literal URL in the client settings. Put the bearer in the named environment variable.

```toml
[mcp_servers.forge-hub]
url = "http://127.0.0.1:3775/mcp"
bearer_token_env_var = "FORGE_HUB_TOKEN"
```

## OpenCode

OpenCode v2 uses `mcp.servers`.

```json
{
  "mcp": {
    "servers": {
      "forge-hub": {
        "type": "remote",
        "url": "http://127.0.0.1:3775/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:FORGE_HUB_TOKEN}" }
      }
    }
  }
}
```

OpenCode v1 puts the same `forge-hub` object directly under `mcp`.

## Messages and recovery

On the hub host, with CLI messaging enabled, `forge-hub inbox --person <personId> --project <projectId>` returns a session id. Use `--session <sessionId>` to reuse it. Acknowledge handled items with `--ack <id>,<id>` and use `--limit <n>` to bound the result.

Send through `forge-hub send --person <personId> --project <projectId> --session <sessionId> --to <personId> --stdin`. Use `--file <path>` in place of `--stdin` to read a file. Use `--target-session <sessionId>` to name a recipient session. Enter message text through the chosen input. CLI messages carry no owner approval.

After a dropped connection, reconnect and initialize MCP again. Call `hello` with the persisted `sessionId`, then read `inbox`. Redelivered items carry `redelivered: true`. Never automatically retry `ask`, `reply` or `send` after a lost response. Reconcile through inbox, the Slack thread or the last known `pendingTo` before trying again. A transport header gives no owner proof.

A T3 agent link forwards T3 operations. The remote Forge MCP still needs its own port reachability and person bearer. Probe T3 port forwarding on the installed version. The local port can change, and forwarding ends when the desktop app quits. Without a working doorbell, use SessionStart, then `inbox` and `wait`.
