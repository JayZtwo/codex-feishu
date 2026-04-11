---
name: codex-feishu
description: |
  Run and diagnose a dedicated Codex-to-Feishu bridge so Codex can chat through
  a Feishu/Lark bot. Use for setup, start, stop, status, logs, reconfigure, and
  doctor flows for the codex-feishu daemon. Do not use for generic Feishu SDK work.
argument-hint: "setup | start | stop | status | logs [N] | reconfigure | doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Codex-Feishu Skill

You are managing the dedicated Codex-to-Feishu bridge.
Runtime state lives at `~/.codex-feishu/`.

The skill directory is `~/.codex/skills/codex-feishu`.

## Command parsing

Map the user's request into one of:

| User says | Subcommand |
|---|---|
| `setup`, `configure`, `配置`, `连上飞书`, `帮我配飞书机器人` | setup |
| `start`, `启动`, `启动 bridge` | start |
| `stop`, `停止`, `停止 bridge` | stop |
| `status`, `状态`, `运行状态` | status |
| `logs`, `查看日志`, `logs 200` | logs |
| `reconfigure`, `修改配置`, `换工作目录` | reconfigure |
| `doctor`, `diagnose`, `诊断`, `没反应了`, `挂了` | doctor |

Use `doctor` when the user reports a symptom.

## Runtime and config rules

- This skill is focused on the Codex + Feishu bridge.
- Before any subcommand other than `setup`, check whether `~/.codex-feishu/config.env` exists.
- If config is missing, show `SKILL_DIR/config.env.example`, explain the required Feishu fields, and stop.
- On macOS and other POSIX shells, use the `scripts/*.sh` entry points.
- On Windows, use `powershell -NoProfile -ExecutionPolicy Bypass -File ...` with the `.ps1` entry points.

## Quick start order

Guide first-time users through this exact sequence:

1. Create a Feishu custom app and copy `App ID` / `App Secret`.
2. Fill `~/.codex-feishu/config.env` using `SKILL_DIR/config.env.example`.
3. In Feishu backend, enable **Bot** and add the required scopes.
4. Publish once.
5. Run `/codex-feishu start`.
6. In Feishu backend, switch **Events & Callbacks** to **Long Connection**, add `im.message.receive_v1`, and add `card.action.trigger`.
7. Publish again.

If the user asks where to click in Feishu backend, read `SKILL_DIR/references/setup-guides.md`.

## Required values

- `CODEX_FEISHU_APP_ID`
- `CODEX_FEISHU_APP_SECRET`
- `CODEX_FEISHU_DEFAULT_WORKDIR`

Recommended defaults:

- `CODEX_FEISHU_DEFAULT_MODE=code`
- `CODEX_FEISHU_DOMAIN=https://open.feishu.cn`

## Subcommands

### `setup`

- Show `SKILL_DIR/config.env.example`.
- Explain the Feishu-specific fields and the two-publish backend checklist.
- Create `~/.codex-feishu/{data,logs,runtime,data/messages}`.
- On POSIX, set `chmod 600 ~/.codex-feishu/config.env` if the file exists.
- Tell the user to run `/codex-feishu start` after the first publish is approved.

### `start`

- Verify config exists.
- On POSIX, run `bash "SKILL_DIR/scripts/daemon.sh" start`.
- On Windows, run `powershell -NoProfile -ExecutionPolicy Bypass -File "SKILL_DIR/scripts/daemon.ps1" start`.
- If start fails, send the user to `/codex-feishu doctor` and `/codex-feishu logs`.

### `stop`

On POSIX, run `bash "SKILL_DIR/scripts/daemon.sh" stop`.
On Windows, run `powershell -NoProfile -ExecutionPolicy Bypass -File "SKILL_DIR/scripts/daemon.ps1" stop`.

### `status`

On POSIX, run `bash "SKILL_DIR/scripts/daemon.sh" status`.
On Windows, run `powershell -NoProfile -ExecutionPolicy Bypass -File "SKILL_DIR/scripts/daemon.ps1" status`.

### `logs`

Extract optional line count `N` (default `50`).
On POSIX, run `bash "SKILL_DIR/scripts/daemon.sh" logs N`.
On Windows, run `powershell -NoProfile -ExecutionPolicy Bypass -File "SKILL_DIR/scripts/daemon.ps1" logs N`.

### `reconfigure`

- Read `~/.codex-feishu/config.env`.
- Show current settings with secrets masked.
- Update the file atomically.
- Re-validate changed Feishu credentials if the user changed them.
- Tell the user to restart the bridge.

### `doctor`

On POSIX, run `bash "SKILL_DIR/scripts/doctor.sh"`.
On Windows, run `powershell -NoProfile -ExecutionPolicy Bypass -File "SKILL_DIR/scripts/doctor.ps1"`.

Use `SKILL_DIR/references/troubleshooting.md` if the basic checks are insufficient.

## Notes

- Never expose secrets in logs or responses.
- Keep runtime state under `~/.codex-feishu/`.
- The daemon is expected to run from this skill directory with `dist/daemon.mjs`.
