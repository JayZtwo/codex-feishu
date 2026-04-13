# codex-feishu

[English](./README.md) | [日本語](./README.ja.md)

`codex-feishu` 是一个把 Feishu/Lark 机器人变成 Codex 移动端控制台的技能。

它面向真实编码场景，而不是普通聊天机器人演示。仓库里打包了运行时、守护进程脚本、飞书配置引导、审批卡片、线程切换和隐私安全默认值，拿来就能装进 `~/.codex/skills/`。

## 为什么值得用

- Codex 到 Feishu 的长连接桥接
- 可选 Rokid 灵珠自定义智能体 HTTP/SSE 入口
- 流式卡片更新
- Feishu 内联权限审批卡片
- 桌面端线程忙碌时的只读跟随
- 线程列表、卡片式线程切换与新线程入口
- 图片 / 文件从 Codex 回传到飞书
- `doctor` 诊断与运维脚本
- 独立运行目录 `~/.codex-feishu`

## 适合的场景

- 你已经在桌面上使用 Codex，希望在手机上继续跟进任务
- 你想通过飞书机器人查看 Codex 的执行过程，而不只是最终答案
- 你需要移动端完成权限审批，而不是守在桌面前点确认

## 仓库包含什么

- 可直接安装到 `~/.codex/skills/codex-feishu` 的技能目录
- 独立 daemon 与 `start/stop/status/logs/doctor` 脚本
- 面向 Feishu 的配置模板
- 覆盖两次发布流程的后台配置文档
- 不带凭证、不带运行时状态的公开版默认值

## 支持矩阵

- `macOS`：正式支持，包含主 daemon 链路和 `launchctl` 集成。
- `Windows`：通过 PowerShell supervisor / install 脚本支持。
- `Codex App / 桌面版`：只要能提供兼容的 `codex` 可执行文件，就可以接入。
- `Codex CLI`：要求支持 `codex app-server`，以及 `config/read`、`thread/start`、`turn/start` 这组 RPC。
- `VS Code 插件`：不是直接集成目标。只有当该安装形态同时暴露兼容的 `codex` 二进制时才可用。

## 快速开始

1. 克隆仓库
2. 安装依赖并构建：

```bash
cd codex-feishu
npm install
npm run build
```

3. 安装到 Codex 技能目录：

macOS / POSIX：

```bash
bash scripts/install-codex.sh
```

Windows：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-codex.ps1
```

4. 按 [config.env.example](./config.env.example) 创建 `~/.codex-feishu/config.env`
5. 按 [references/setup-guides.md](./references/setup-guides.md) 配置 Feishu 后台
6. 启动 bridge：

macOS / POSIX：

```bash
bash scripts/daemon.sh start
```

Windows：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\daemon.ps1 start
```

或者在 Codex 里执行：

```text
/codex-feishu start
```

## 移动端工作流

- 在飞书里让 Codex 看代码、跑检查、改文件
- 需要提权时直接在飞书里点审批卡片
- 桌面端线程正在忙时，飞书只读跟随，不会抢线程
- 通过线程列表和切换命令回到特定上下文继续聊

## Rokid 灵珠眼镜触发

如果你要让 Rokid 眼镜触发 Codex，可以启用可选的 Lingzhu 自定义智能体入口：

```bash
CODEX_FEISHU_ROKID_ENABLED=true
CODEX_FEISHU_ROKID_HOST=127.0.0.1
CODEX_FEISHU_ROKID_PORT=8787
CODEX_FEISHU_ROKID_PATH=/rokid/agent
CODEX_FEISHU_ROKID_SECRET=replace-with-a-long-random-token
CODEX_FEISHU_ROKID_AUTO_ALLOW_PERMISSIONS=true
```

然后在灵珠的“三方智能体导入 / 自定义智能体”流程里配置公网 HTTPS 地址，反向代理到本机 `http://127.0.0.1:8787/rokid/agent`。详细说明见 [references/rokid-lingzhu.md](./references/rokid-lingzhu.md)。

眼镜端默认会自动允许 Codex 权限请求，因为它不是一个适合审批的交互面。公网暴露时务必使用 HTTPS、长随机 secret 和可选用户/设备 allowlist；如果你想强制审批，可以设 `CODEX_FEISHU_ROKID_AUTO_ALLOW_PERMISSIONS=false`。

## Feishu 后台配置顺序

必须按这个顺序来：

1. 创建自建应用，拿到 `App ID` / `App Secret`
2. 添加所需 scopes
3. 开启 **Bot**
4. 发布第一版
5. 启动 bridge
6. 配置 **Long Connection**
7. 添加 `im.message.receive_v1`
8. 添加 `card.action.trigger`
9. 发布第二版

少任何一步，通常都会出现“能连上但收不到消息”或“权限卡片不可用”的问题。

## 常用命令

- `/codex-feishu setup`
- `/codex-feishu start`
- `/codex-feishu stop`
- `/codex-feishu status`
- `/codex-feishu logs`
- `/codex-feishu doctor`

详细说明见 [references/usage.md](./references/usage.md)。

## 兼容性说明

- 现在的 `doctor` 不只检查 `codex --version`，还会实际探测 `codex app-server` 握手是否可用。
- 较旧的 Codex 版本可能看起来“CLI 存在”，但如果没有这套 app-server RPC，bridge 仍然不能工作。
- 如果你机器上有多个 Codex 安装，可以用 `CODEX_FEISHU_CODEX_EXECUTABLE` 指定要接入的那一个。

## 公开版目标

- 专注 Codex + Feishu，并提供可选 Rokid 灵珠触发入口
- 不把 secrets、运行时状态、聊天历史提交进 git
- 让不了解内部背景的人也能按文档独立搭起来

## 仓库结构

- [SKILL.md](./SKILL.md)：Codex 技能入口
- [src](./src)：运行时代码
- [scripts](./scripts)：守护进程与安装脚本
- [references](./references)：飞书配置、Rokid 灵珠接入与排障文档

## 隐私说明

- 仓库内不包含真实飞书凭证
- 运行数据默认写入 `~/.codex-feishu`
- `config.env`、`node_modules`、`dist` 和运行时产物都不会被 git 跟踪

## 开源协议

MIT，见 [LICENSE](./LICENSE)。
