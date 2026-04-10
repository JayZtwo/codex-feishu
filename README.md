# codex-feishu

[简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

`codex-feishu` turns a Feishu/Lark bot into a practical mobile console for Codex.

It is built for real remote coding, not generic chatbot demos. The repository packages the bridge runtime, daemon scripts, Feishu onboarding, approval cards, thread controls, and privacy-safe defaults into one installable Codex skill.

## Why people use it

Most IM bridges stop at "send a message to an LLM". This one is aimed at actual coding workflows:

- Feishu long-connection bridge for Codex
- streaming updates instead of final-answer-only replies
- inline permission approval cards in Feishu
- thread listing, card-based switching, and busy-thread follow mode
- image and file delivery back to Feishu
- friendly diagnostics with `doctor`
- isolated runtime state under `~/.codex-feishu`

## What is included

- A Codex skill directory you can install into `~/.codex/skills/codex-feishu`
- A dedicated daemon with start/stop/status/logs scripts
- A Feishu-first config template
- Feishu backend documentation that covers the full two-publish flow
- Public-safe defaults with no bundled secrets or runtime history

## Feature overview

- Remote coding from Feishu without giving up desktop Codex
- Busy desktop thread protection with read-only follow mode
- Approval workflow for commands and file changes
- Thread-aware continuation instead of stateless chat
- Feishu card updates tuned for long-running coding tasks
- thread picker cards with switch and new-thread actions
- Operational scripts for install, start, stop, logs, and doctor

## Quick start

1. Clone this repository.
2. Run:

```bash
cd codex-feishu
npm install
npm run build
```

3. Copy or symlink the folder into your Codex skills directory:

```bash
bash scripts/install-codex.sh
```

4. Create `~/.codex-feishu/config.env` from [config.env.example](./config.env.example).
5. Follow the Feishu backend guide in [references/setup-guides.md](./references/setup-guides.md).
6. Start the bridge:

```bash
bash scripts/daemon.sh start
```

Or from Codex:

```text
/codex-feishu start
```

## What the mobile workflow looks like

- Ask Codex to inspect or modify your project from Feishu
- Approve risky actions from a permission card when needed
- Follow an already-running desktop thread without taking it over
- Switch back to a specific thread from Feishu and continue there

## Feishu setup summary

The Feishu side must be done in this order:

1. Create a custom app and get `App ID` / `App Secret`
2. Add the required scopes
3. Enable **Bot**
4. Publish once
5. Start the bridge
6. Set **Long Connection**
7. Add `im.message.receive_v1`
8. Add `card.action.trigger`
9. Publish again

If you skip either publish, the bot usually looks "half configured" and fails in confusing ways.

## Main commands

- `/codex-feishu setup`
- `/codex-feishu start`
- `/codex-feishu stop`
- `/codex-feishu status`
- `/codex-feishu logs`
- `/codex-feishu doctor`

More detail: [references/usage.md](./references/usage.md)

## Repository goals

- Keep the repo focused on Codex + Feishu
- Keep secrets, runtime state, and chat history out of git
- Make setup explicit enough that another user can get working without private context

## Repository layout

- [SKILL.md](./SKILL.md): skill instructions for Codex
- [src](./src): runtime source
- [scripts](./scripts): daemon management and install helpers
- [references](./references): Feishu onboarding and troubleshooting docs

## Privacy and safety

- This repository does not include any real Feishu credentials.
- Runtime data is expected under `~/.codex-feishu`, not in the repository.
- `config.env`, `node_modules`, `dist`, and runtime artifacts are ignored by git.

## License

MIT. See [LICENSE](./LICENSE).
