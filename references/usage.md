# Usage Guide

This package is focused on **Codex + Feishu**, with an optional Rokid Lingzhu trigger endpoint.

## First-time setup

1. Run:

```text
/codex-feishu setup
```

2. Fill `~/.codex-feishu/config.env` from the template.
3. Follow [setup-guides.md](./setup-guides.md):
   - add scopes
   - enable bot
   - first publish
   - start bridge
   - long connection
   - callbacks
   - second publish

## Minimal config

```dotenv
CODEX_FEISHU_DEFAULT_WORKDIR=/Users/me/project
CODEX_FEISHU_DEFAULT_MODE=code

CODEX_FEISHU_APP_ID=cli_xxxxx
CODEX_FEISHU_APP_SECRET=your-secret
```

## Start

```text
/codex-feishu start
```

Platform-specific entry points:

- macOS / POSIX: `bash scripts/daemon.sh start`
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\daemon.ps1 start`

This writes runtime state to:

- `~/.codex-feishu/runtime/bridge.pid`
- `~/.codex-feishu/runtime/status.json`
- `~/.codex-feishu/logs/bridge.log`

## Stop

```text
/codex-feishu stop
```

- macOS / POSIX: `bash scripts/daemon.sh stop`
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\daemon.ps1 stop`

## Status

```text
/codex-feishu status
```

Use this to confirm the daemon is up before configuring long connection in Feishu.

- macOS / POSIX: `bash scripts/daemon.sh status`
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\daemon.ps1 status`

## Logs

```text
/codex-feishu logs
/codex-feishu logs 200
```

- macOS / POSIX: `bash scripts/daemon.sh logs 200`
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\daemon.ps1 logs 200`

Use logs when:

- Feishu messages are not received
- permission cards do not appear
- thread switch cards do not respond
- the bridge seems online but no reply is sent

## Thread commands

Inside Feishu you can use:

- `显示线程`
- `线程列表`
- `切换线程 2`
- `/thread switch 2`

The bridge will also send a thread picker card with buttons for switching and creating a new thread.

When the target desktop thread is still running, the bridge enters follow mode instead of taking over that thread.

## Reconfigure

```text
/codex-feishu reconfigure
```

After changing config, restart:

```text
/codex-feishu stop
/codex-feishu start
```

## Rokid Lingzhu

Enable the optional HTTP/SSE endpoint if you want Rokid glasses to trigger Codex through Lingzhu's custom-agent import flow:

```dotenv
CODEX_FEISHU_ROKID_ENABLED=true
CODEX_FEISHU_ROKID_PORT=8787
CODEX_FEISHU_ROKID_PATH=/rokid/agent
CODEX_FEISHU_ROKID_SECRET=replace-with-a-long-random-token
CODEX_FEISHU_ROKID_AUTO_ALLOW_PERMISSIONS=true
```

Then expose `http://127.0.0.1:8787/rokid/agent` behind HTTPS and configure that URL in Lingzhu. See [rokid-lingzhu.md](./rokid-lingzhu.md).

## Doctor

```text
/codex-feishu doctor
```

Current checks include:

- Node.js version
- Codex CLI availability
- Codex app-server handshake readiness
- Codex login / auth availability
- dependency installation
- daemon bundle freshness
- config existence and permissions
- Feishu app credential validation
- log directory writability
- PID consistency
