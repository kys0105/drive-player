# Vercel移管記録

2026-10-28。Codex版のデザインを正として本番アプリへ統合。Claude Designの成果は取り込まず、元の作業フォルダ・Temp成果物・起動設定も変更しない。

## 対象

- リポジトリ: `kys0105/drive-player`
- 作業ブランチ: `codex/mobile-redesign`
- Vercel: `yumosin-house-studio / drive-player`
- プロジェクトID: `prj_sXopOKpBhn3sbzffv5BZe6q7kOzy`
- Node.js: 24系。ローカルのビルド／検証は24.22.1。
- Functions: 東京 `hnd1`、Fluid compute、上限300秒。音源はバッファせずストリーム配信。
- 旧サイト: `https://setagayagenico-ls-3.netlify.app`
- 旧Netlifyの切替前公開デプロイ: `6adf4f3b527be3d27b618f7e`

## 設定と公開前の条件

既存のProductionにある `APP_PASSWORD_HASH`, `SESSION_SECRET`, `FOLDER_ID`, `GOOGLE_SERVICE_ACCOUNT` を、値を表示せずVercel ProductionのSecretへ移管した。共通パスワードは変更していない。新しいoriginではログインと音源の保存をやり直す必要がある。ブラウザのCookie／保存領域は旧サイトから自動移行できない。

Vercelの標準デプロイ保護を使用し、固定本番エイリアスはアプリの認証で保護、プレビュー・個別デプロイURLはVercel認証で保護する。

ログインは同一のWAFルールで `/api/login` と `/.netlify/functions/login` のPOSTを、IPごとに60秒10回までとし、超過時に429を返す。設定を公開済み。自動DDoS／システム緩和は有効。追加の有料サービスは新設していない。

切替前に、lint／build／security／lyrics、Chromeの実操作、未認証拒否、Drive一覧、Range／HEAD、4.5MB超のストリーム、WAFの両ルートでの実動作を確認する。

## デプロイとロールバック

Vercel CLI 65.4.0で対象プロジェクトを明示的にリンクし、`project inspect --non-interactive` で所有チーム・プロジェクトIDを確認した。`.vercelignore` によりClaude成果、試作品、ローカル秘密、テスト用データはデプロイしない。

Production環境のデプロイを `--skip-domain` で作成し、確認してから同じデプロイをpromoteする。公開後の障害時はVercelで以前の確認済みデプロイをpromoteし直す。初回の問題なら旧Netlifyの記録済み公開デプロイを復元できる。新環境での認証scope・端末保存は旧環境と独立する。

実行結果と最終URLは検証完了後に追記する。
