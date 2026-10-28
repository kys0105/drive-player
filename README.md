# SetagayaGenico / Drive Player

Google Driveの音源を、iPhone・Androidのブラウザで聴くためのアプリです。Codexで確認した白いライブラリと濃紺の再生画面を本番UIの基準にしています。

本番: **https://drive-player-yumosin-house-studio.vercel.app/**

旧Netlify URLは新しい本番へ転送します。パスワードは従来どおりです。初回は新しいサイトでログインし、必要な曲を再保存してください。

## 主な機能

- 公開対象ルート直下のアルバムフォルダを選択。フォルダを見比べても、再生中の曲とキューは維持します。
- 曲検索、ミニプレイヤー、再生詳細、シーク、前後の曲、1曲／全曲リピート、連続再生。
- フォルダごとの曲順を端末内に保存し、既存の「ゆもしんの曲順」へ切り替えられます。
- 曲を選んで音源と関連するDrive歌詞を端末へ保存。保存中の取消、失敗後の再試行、まとめて保存、保存済みの削除。
- 保存済み音源はローカルの完全データから再生・シークし、再生開始のために毎回サーバー認証を待ちません。
- 最後に有効なログインをオンラインで確認してから30日間、保存曲と一覧を圏外でも開けます。通信失敗や単なる再生で期限を延ばしません。
- 歌詞はGoogle Driveを標準の取得元とし、同じ名前のLRCを優先、なければTXTを使用。「追従／全文」を切り替えられます。端末限定の手動歌詞は別に保持します。
- PWA対応。iPhoneはSafariの共有メニューから「ホーム画面に追加」、Androidはブラウザのインストール機能で追加できます。

フォルダ構成・歌詞更新・保存の手順は [Driveライブラリと歌詞の運用ガイド](docs/DRIVE-LIBRARY-LYRICS.md) を参照してください。この対応版の文書は、実Driveの配置変更や本番反映の完了記録ではありません。

## 実行環境と開発

Node.js **24.22.1以上・25未満**を使用します。Vercelのビルド・Functionsも24系です。

```sh
npm ci
npm run dev
```

Vite単体はUIのみです。APIを含む開発には、対象のVercelプロジェクトを確認してから `vercel dev` を使い、ローカルの環境変数を用意してください。

`.env.example` のサーバー用4項目を設定します。`GOOGLE_SERVICE_ACCOUNT_BASE64` または `GOOGLE_SERVICE_ACCOUNT` のいずれかに、対象Driveフォルダの読み取り権限だけを持つサービスアカウントを指定します。秘密値へ `VITE_` を付けたり、フロントエンドやGitへ埋め込んだりしないでください。

```sh
npm run lint
npm run build
npm run test:security
npm run test:lyrics
npm audit --omit=dev
```

実際のAPIハンドラーにDrive上流だけを置き換えた検証画面は、ビルド後 `node tests/security/preview-server.mjs` でlocalhost:4177に起動します。これはテスト専用のパスワード・無音音源を使い、本番には含めません。

## 認証・複数人での利用

共通パスワードをサーバーで検証し、署名付きのHttpOnly Cookieを発行します。HTTPS・SameSite=Strictで、各ブラウザに異なる認証scopeを発行します。曲順、端末限定の歌詞、保存曲、再生状態は端末ごとに独立します。Drive上の歌詞は共通のデータとして参照します。

オンラインで401を確認すると再生を停止し、その端末の許可・保存音源・歌詞を削除して再ログインを求めます。ログアウトも同様です。圏外の端末にはパスワード変更を即時反映できず、既存の30日許可が残る場合があります。

Cookieの期限と圏外利用の期限は別です。ブラウザの保存領域の削除、容量不足、端末の日時変更、保存中に画面を閉じる操作などでは、オンラインでの再確認や再保存が必要になることがあります。

## Vercel

プロジェクト: `yumosin-house-studio / drive-player`。本番設定はProductionのSecretとして管理します。Previewへ本番のDrive接続設定を複製しません。

通常の本番更新はGitHubの`main`をVercelへ自動デプロイします。旧Netlifyの自動ビルドは停止し、転送だけを提供します。

APIは `/api/login`, `/api/session`, `/api/logout`, `/api/albums`, `/api/list?albumId=...`, `/api/stream/:id`, `/api/lyrics/:audioId`。旧Netlify APIのパスも認証を通る互換ルートにしています。音源は設定済みルート直下、またはその直下の通常フォルダ内のMP3だけを取得し、ストリームで配信します。歌詞も同じ認証・所属確認の内側で配信し、APIは共有CDNへ保存しません。

`FOLDER_ID` は既存の `00_試聴用` のDrive IDを維持します。フォルダの移動・改名では同名フォルダを作り直さないでください。必要な場合は `DEFAULT_ALBUM_ID` で既定アルバムを指定できます。共通パスワードも、この構成変更では変更しません。

パスワード変更は `npm run auth:setup` で8文字以上のパスワードからハッシュを作成し、[Vercelの環境変数](https://vercel.com/yumosin-house-studio/drive-player/settings/environment-variables)でProductionの `APP_PASSWORD_HASH` を更新し、再デプロイします。生成ツールは既存のローカル設定があると上書きを拒否します。ローカルファイルの変更だけで本番は変わりません。

移管・切替・ロールバックの記録は [docs/VERCEL-MIGRATION.md](docs/VERCEL-MIGRATION.md) を参照してください。Claude Designの元データ・設定は変更しません。
