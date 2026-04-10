# codex-feishu

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-feishu` は、Feishu/Lark ボットを Codex のモバイル操作面に変えるスキルです。

一般的なチャットボット連携ではなく、実際の開発運用を前提にしています。リポジトリには、実行時ブリッジ、デーモンスクリプト、Feishu 設定手順、承認カード、スレッド切り替え、公開用の安全な初期設定が含まれます。

## 主な機能

- Codex と Feishu の長连接ブリッジ
- ストリーミング更新カード
- Feishu 上での権限承認カード
- デスクトップ側が作業中のときの busy-thread follow
- スレッド一覧、カード式スレッド切り替え、新規スレッド作成
- 画像とファイルの Feishu 返送
- `doctor` による診断

## クイックスタート

1. リポジトリを clone
2. 依存関係を入れてビルド

```bash
cd codex-feishu
npm install
npm run build
```

3. Codex skills にインストール

```bash
bash scripts/install-codex.sh
```

4. [config.env.example](./config.env.example) を元に `~/.codex-feishu/config.env` を作成
5. [references/setup-guides.md](./references/setup-guides.md) に沿って Feishu 側を設定
6. ブリッジ起動

```bash
bash scripts/daemon.sh start
```

または Codex から:

```text
/codex-feishu start
```

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

## プライバシー

- 実際の Feishu credentials は含みません
- 実行時データは `~/.codex-feishu` に保存されます
- `config.env`、`node_modules`、`dist` は git 管理外です
