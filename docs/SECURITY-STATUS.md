# セキュリティ対応状況

確認日: 2026年10月26日（日本時間）

## 実装・確認済み

- パスワードのサーバー側scrypt照合、署名付きHttpOnly Cookie、Origin検証、ログイン試行のレート制限。
- list/streamの認証、指定フォルダ・音声MIME・削除状態の認可。
- 音声の共有HTTPキャッシュ禁止、Service Workerのセッション別キャッシュと認証確認、ログアウト時の停止・削除。
- 複数人の独立したログインと、一人のログアウトが別ブラウザへ影響しないことを含む38件の回帰テスト。
- Node.js 24.22.1でlint/build成功、依存関係のnpm auditは0件。
- Netlify本番で未認証APIの401、共通パスワードによる独立セッション、実Drive一覧取得、1024バイトのRange取得、HEAD応答を確認。
- Netlify Firewallでunpublished deploysを遮断。旧固定URLの無認証APIへの到達を防ぎ、履歴は保持。本番URLのAPIは認証で保護。
- 新しい共通パスワード・署名鍵を生成し、本番環境変数へ登録。生成値はGit管理対象外で、公開JS/CSSへの混入も確認。

## 残存事項: 管理ランタイムのパッチ確認

リポジトリのNode指定、ビルド、検証は **24.22.1** に統一。本番環境変数の `AWS_LAMBDA_JS_RUNTIME` は **nodejs24.x** に設定済みです。

ただし、再デプロイ後のNetlify Functionsの実測値は以下でした。診断用関数は確認後に削除しています。

| 項目 | 実測 |
| --- | --- |
| Node.js | v24.21.0 |
| Brotli | 1.2.0 |
| Undici | 7.29.1 |

upstreamの24.21.0は10月21日のセキュリティリリース24.22.1より前です。BrotliのCVE-2026-111497等の修正が、管理ランタイムに独自バックポートされているかは確認できていません。バージョン値だけでバックポートの有無は断定せず、**本番Nodeの脆弱性対応完了とは扱いません**。

Netlifyが公開している選択肢は `nodejs24.x` までで、Functionsのパッチ版を利用者が指定する手段は確認できませんでした。Node24系は維持し、Netlifyへ修正適用状況・更新時期を確認する必要があります。この照会はまだ送信していません。

現在のアプリはGoogle APIの固定ホストへ通信し、音声取得は `Accept-Encoding: identity` を指定します。攻撃者が任意の上流URLやBrotli入力を指定する経路は見つかっていませんが、これはランタイム自体の修正を代替するものではありません。

一次資料:

- [Node.js 24.22.1のセキュリティリリース](https://nodejs.org/en/blog/release/v24.22.1)
- [Node.js 10月21日のセキュリティ公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Netlify Functionsの実行Node設定](https://docs.netlify.com/build/functions/configuration/#nodejs-version-for-runtime)
- [AWS Lambdaのランタイム更新](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-update.html)
