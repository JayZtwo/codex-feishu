# codex-feishu

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-feishu` は、Feishu/Lark ボットを Codex のモバイル操作面に変えるスキルです。

一般的なチャットボット連携ではなく、実際の開発運用を前提にしています。リポジトリには、実行時ブリッジ、デーモンスクリプト、Feishu 設定手順、承認カード、スレッド切り替え、公開用の安全な初期設定が含まれます。

## 主な機能

- Codex と Feishu の長连接ブリッジ
- Rokid Lingzhu カスタムエージェント向けの任意 HTTP/SSE エンドポイント
- ストリーミング更新カード
- Feishu 上での権限承認カード
- デスクトップ側が作業中のときの busy-thread follow
- スレッド一覧、カード式スレッド切り替え、新規スレッド作成
- 画像とファイルの Feishu 返送
- `doctor` による診断

## 対応マトリクス

- `macOS`: 正式サポート。主要なデーモン経路と `launchctl` 連携を含みます。
- `Windows`: PowerShell の supervisor / install スクリプト経由でサポートします。
- `Codex app / デスクトップ版`: 互換性のある `codex` 実行ファイルを提供していれば利用できます。
- `Codex CLI`: `codex app-server` と `config/read`、`thread/start`、`turn/start` RPC が使えることが前提です。
- `VS Code plugin`: 直接統合はしていません。互換性のある `codex` バイナリも提供する場合のみ利用可能です。

## クイックスタート

1. リポジトリを clone
2. 依存関係を入れてビルド

```bash
cd codex-feishu
npm install
npm run build
```

3. Codex skills にインストール

macOS / POSIX:

```bash
bash scripts/install-codex.sh
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-codex.ps1
```

4. [config.env.example](./config.env.example) を元に `~/.codex-feishu/config.env` を作成
5. [references/setup-guides.md](./references/setup-guides.md) に沿って Feishu 側を設定
6. ブリッジ起動

macOS / POSIX:

```bash
bash scripts/daemon.sh start
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\daemon.ps1 start
```

または Codex から:

```text
/codex-feishu start
```

## Rokid Lingzhu

Rokid グラスから Codex を起動したい場合は、Lingzhu のカスタムエージェント import 用に任意の HTTP/SSE endpoint を有効化できます。

```bash
CODEX_FEISHU_ROKID_ENABLED=true
CODEX_FEISHU_ROKID_PORT=8787
CODEX_FEISHU_ROKID_PATH=/rokid/agent
CODEX_FEISHU_ROKID_SECRET=replace-with-a-long-random-token
CODEX_FEISHU_ROKID_AUTO_ALLOW_PERMISSIONS=true
```

詳細は [references/rokid-lingzhu.md](./references/rokid-lingzhu.md) を参照してください。

## セットアップ順序

1. Feishu カスタムアプリを作成
2. 必要な scopes を追加
3. Bot を有効化
4. 1 回目の publish
5. ブリッジ起動
6. Long Connection を有効化
7. `im.message.receive_v1` を追加
8. `card.action.trigger` を追加
9. 2 回目の publish

## 互換性メモ

- `doctor` は `codex --version` だけでなく、実際の `codex app-server` ハンドシェイクも検証します。
- 古い Codex は CLI 自体が存在していても、必要な app-server RPC がなければこの bridge では利用できません。
- Codex を複数インストールしている場合は、`CODEX_FEISHU_CODEX_EXECUTABLE` で利用するバイナリを固定できます。

## プライバシー

- 実際の Feishu credentials は含みません
- 実行時データは `~/.codex-feishu` に保存されます
- `config.env`、`node_modules`、`dist` は git 管理外です
