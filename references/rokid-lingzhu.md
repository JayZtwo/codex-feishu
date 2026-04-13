# Rokid Lingzhu Integration

`codex-feishu` can expose an optional HTTP/SSE endpoint for Rokid Lingzhu custom-agent import. This keeps Codex as the primary agent while letting Rokid glasses trigger a Codex turn by voice.

## Recommended Path

Use Lingzhu's third-party/custom-agent import flow and point it at this bridge endpoint:

```text
POST https://your-public-domain.example/rokid/agent
Authorization: Bearer <CODEX_FEISHU_ROKID_SECRET>
Accept: text/event-stream
Content-Type: application/json
```

The endpoint accepts flexible request shapes. Any of these fields can carry the user prompt:

```json
{
  "session_id": "rokid-session-1",
  "user_id": "user-1",
  "message_id": "message-1",
  "query": "帮我看一下当前项目状态"
}
```

It also understands common alternatives such as `prompt`, `text`, `message`, `content`, `conversation_id`, `device_id`, and OpenAI-style `messages[]`.

## Config

Add these values to `~/.codex-feishu/config.env`:

```bash
CODEX_FEISHU_ROKID_ENABLED=true
CODEX_FEISHU_ROKID_HOST=127.0.0.1
CODEX_FEISHU_ROKID_PORT=8787
CODEX_FEISHU_ROKID_PATH=/rokid/agent
CODEX_FEISHU_ROKID_SECRET=replace-with-a-long-random-token
CODEX_FEISHU_ROKID_AUTO_ALLOW_PERMISSIONS=true
```

`CODEX_FEISHU_ROKID_SECRET` is required. If you expose the endpoint through a reverse proxy or tunnel, terminate HTTPS there and forward to `127.0.0.1:8787`.

Optional allowlist:

```bash
CODEX_FEISHU_ROKID_ALLOWED_USERS=user_id_1,device_or_session_id_2
```

## SSE Output

The bridge emits standard Server-Sent Events:

```text
event: ready
data: {"type":"ready","channel":"rokid","session_id":"...","message_id":"..."}

event: message
data: {"type":"text_delta","role":"assistant","delta":"...","content":"...","text":"..."}

event: tools
data: {"type":"tools","tools":[...]}

event: done
data: {"type":"done","status":"completed","content":"...","elapsed_ms":1234}
```

If Lingzhu requires a narrower event schema, keep the same endpoint and adapt only `src/bridge/rokid.ts`.

## Safety Model

Rokid is best for short trigger and status interactions. By default, Rokid-triggered turns auto-allow Codex permission requests because glasses are a poor approval surface. Set `CODEX_FEISHU_ROKID_AUTO_ALLOW_PERMISSIONS=false` if you want to force approvals back through Feishu or desktop Codex.

Keep this endpoint behind a strong secret, HTTPS, and a narrow allowlist if it is reachable from the internet.

## Local Smoke Test

```bash
curl -N \
  -H "Authorization: Bearer $CODEX_FEISHU_ROKID_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"smoke","user_id":"local","query":"hi"}' \
  http://127.0.0.1:8787/rokid/agent
```
