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

Production環境へリリースし、Vercel上で実音源を確認してから旧Netlifyを切り替える。公開後の障害時はVercelで以前の確認済みデプロイをpromoteし直す。初回の問題なら旧Netlifyの記録済み公開デプロイを復元できる。新環境での認証scope・端末保存は旧環境と独立する。

## 切替の結果

- 本番URL: **https://drive-player-yumosin-house-studio.vercel.app/**
- 初回の検証済み本番デプロイ: `dpl_8vuXceE3G5erB9rqHnYtA1wi9ZYq`（ソース`8854d53`）。以後はmainのGit連携デプロイで更新する。
- 2026-10-28 12:07 JST、実Driveの10曲取得、未認証401、他originログイン403、既存パスワードでログイン200、Range206、HEAD200、全音源200を確認。
- 5,184,064バイトの音源をストリーム配信し、DriveのMD5と一致。4.5MBを超える応答も正常。
- WAF実測: 誤パスワード10回は401、11回目以降429。旧API aliasも同じカウンターで429。
- Chrome本番でnoahの実再生、保存完了、保存済み音源の再起動後再生を確認。390×844と360×740で画面全体がスクロールせず主要操作が収まることを確認。
- 2026-10-28 12:08 JST、旧Netlifyを転送専用デプロイ`6ae16710d8421f9d7d0d9f45`へ変更。旧ルート・旧APIは新URLへの302、`/sw.js`は登録解除用workerの200を実測。Chromeでも移動を確認。
- Netlifyの`build_settings.stop_builds=true`を設定・再読取確認済み。Gitの更新で旧アプリが再公開されないようにした。

バックエンドはNodeNextの出力先`.js`を相対importし、Vercel上の実行コードと解決先を一致させる。VercelのREADY表示だけではAPI起動成功を意味しないため、匿名リクエスト・認証・実音源のHTTP確認までを公開チェックに含める。
