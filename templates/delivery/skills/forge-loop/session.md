# Session ownership

Threaded chats: call MCP `t3_thread_configuration` once (no args) and set `FORGE_SESSION=t3:<threadId>` for every forge command, even after a harness switch. Workers you launch keep their own task session.

Before any worker claim, set its session: POSIX `export FORGE_SESSION="<slice>-worker"`; PowerShell `$env:FORGE_SESSION="<slice>-worker"`. Never use the chat's `t3:` session for a worker; reuse on re-dispatch. On restart, use the holder-session recovery in [resume.md](resume.md) before claiming or renewing inherited work.
