# Feishu Setup Guide

This skill is intentionally scoped to **Codex + Feishu/Lark**.

## 1. Create the Feishu app

1. Open [Feishu Open Platform](https://open.feishu.cn/app).
2. Click **Create Custom App**.
3. Open **Credentials & Basic Info**.
4. Copy:
   - `App ID`
   - `App Secret`

These map to:

- `CODEX_FEISHU_APP_ID`
- `CODEX_FEISHU_APP_SECRET`

For Lark international, set `CODEX_FEISHU_DOMAIN=https://open.larksuite.com`.
For mainland Feishu, use `https://open.feishu.cn` or leave it unset.

## 2. Prepare config.env

Write this to `~/.codex-feishu/config.env`:

```dotenv
CODEX_FEISHU_DEFAULT_WORKDIR=/path/to/your/project
CODEX_FEISHU_DEFAULT_MODE=code

CODEX_FEISHU_APP_ID=cli_xxxxx
CODEX_FEISHU_APP_SECRET=your-secret
# CODEX_FEISHU_DOMAIN=https://open.feishu.cn
# CODEX_FEISHU_ALLOWED_USERS=ou_xxxxx
```

## 3. Add required scopes

Open **Permissions & Scopes** and add these tenant scopes:

```json
{
  "scopes": {
    "tenant": [
      "im:message:send_as_bot",
      "im:message:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:update",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:chat:read",
      "im:resource",
      "cardkit:card:write",
      "cardkit:card:read"
    ],
    "user": []
  }
}
```

## 4. Enable the bot

1. Open **Add Features**.
2. Enable **Bot**.
3. Set a bot name and description.

## 5. First publish

1. Open **Version Management & Release**.
2. Create a version.
3. Submit it for review and finish approval.

## 6. Start the bridge

Run:

macOS / POSIX:

```bash
bash /path/to/codex-feishu/scripts/daemon.sh start
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\codex-feishu\scripts\daemon.ps1 start
```

Or from Codex:

```text
/codex-feishu start
```

## 7. Configure long connection and callbacks

Do this only after the bridge is running.

1. Open **Events & Callbacks**.
2. Set **Event Dispatch Method** to **Long Connection**.
3. Add event `im.message.receive_v1`.
4. Add callback `card.action.trigger`.
5. Save.

## 8. Second publish

After adding events and callbacks, publish again:

1. Open **Version Management & Release**.
2. Create a new version.
3. Submit and finish approval.

## 9. Common mistakes

- Missing `im:message.p2p_msg:readonly`: private chat messages will not arrive.
- Missing `card.action.trigger`: permission buttons and thread picker actions will not work.
- Only one publish completed: the bot often looks half-configured.
- Bridge not running during callback setup: long connection save may fail.
- Two bridges running with the same Feishu app: they will compete for the same connection.
