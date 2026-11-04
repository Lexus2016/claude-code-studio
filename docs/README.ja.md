# Claude Code Studio：日本語クイックスタート

Claude Code Studio は、Claude Code CLI のためのセルフホスト型 Web・デスクトップ作業環境です。チャット、Kanban タスク、プロジェクト管理をまとめて扱えます。

この文書は簡単な導入ガイドです。全機能と更新時の注意事項は [English README](../README.md) を参照してください。

## デモ

[30 秒のデモを見る](media/claude-code-studio-promo.mp4)

## インストール

Claude Code CLI をインストールし、ログインしておく必要があります。Web 版には Node.js も必要です。組み込み SQLite を使える 22.13 以降を推奨します。それより古い対応バージョンではネイティブビルド用ツールが必要になる場合があります。

```bash
npx github:Lexus2016/claude-code-studio
```

http://localhost:3000 を開き、パスワードを設定してプロジェクトを追加します。

デスクトップ版は [GitHub Releases](https://github.com/Lexus2016/claude-code-studio/releases/latest) からダウンロードできます。OS に合うファイルを選んでください。macOS 版は Apple Silicon 向けです。

## 安全に使うために

Studio は Claude Code を通じてローカルのコマンド実行やファイル編集を行い、`--dangerously-skip-permissions` を使用します。信頼できるプロジェクトで使い、バックアップを残してください。Web 版は既定で localhost のみを待ち受けます。ポートをそのままインターネットに公開しないでください。リモートアクセス、Docker、リバースプロキシの注意事項は英語版 README を参照してください。

## フィードバック

再現手順を添えて [Issues](https://github.com/Lexus2016/claude-code-studio/issues) に報告してください。API キー、セッション Cookie、SSH 認証情報、非公開プロジェクトのファイルは投稿しないでください。開発・テスト手順は [CONTRIBUTING.md](../CONTRIBUTING.md) にあります。
