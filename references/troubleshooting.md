# Troubleshooting

## Bridge won't start

**Symptoms**: `/codex-feishu start` fails or daemon exits immediately.

**Steps**:

1. Run `/codex-feishu doctor` to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that Codex CLI is available: `codex --version`
4. Verify config exists: `ls -la ~/.codex-feishu/config.env`
5. Check logs for startup errors: `/codex-feishu logs`

**Common causes**:
- Missing or invalid config.env -- run `/codex-feishu setup`
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another instance is running with `/codex-feishu status`

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify Feishu app credentials: `/codex-feishu doctor`
2. Confirm the app has completed both publish cycles
3. Confirm **Long Connection** is enabled
4. Confirm `im.message.receive_v1` and `card.action.trigger` are saved
5. Check logs for incoming message events: `/codex-feishu logs 200`

## Permission timeout

**Symptoms**: Codex starts working but the permission card does not arrive or approval does nothing.

**Steps**:

1. Confirm `card.action.trigger` callback is configured and published
2. Confirm the bridge is connected through Feishu long connection
3. Check logs for permission forwarding and callback handling
4. Trigger a deterministic permission test with `测试授权链路` or `/permtest`

## Thread picker card does not respond

**Symptoms**: The thread list card appears, but button clicks do nothing.

**Steps**:

1. Confirm `card.action.trigger` is configured and the second publish is already approved
2. Confirm the bridge is running before saving Feishu callback settings
3. Check `/codex-feishu logs 200` for callback handling errors
4. As a fallback, use text commands such as `线程列表` and `切换线程 2`

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current memory usage: `/codex-feishu status`
2. Restart the daemon to reset memory:
   ```
   /codex-feishu stop
   /codex-feishu start
   ```
3. If the issue persists, check how many concurrent sessions are active
4. Review logs for error loops that may cause memory leaks

## Busy thread behavior

**Symptoms**: You switch to a desktop thread in Feishu and expect continuation, but the thread is still working.

**Expected behavior**:

1. Feishu returns `当前线程忙碌中`
2. The current desktop thread output is mirrored to Feishu
3. After the desktop thread finishes, the next Feishu message can continue the thread normally

If this does not happen, inspect `/codex-feishu logs 200` and confirm you switched to the intended thread.

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Run `/codex-feishu stop` -- it will clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.codex-feishu/runtime/bridge.pid
   ```
3. Run `/codex-feishu start` to launch a fresh instance
