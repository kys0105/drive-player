# Drive Player

Google ドライブ上の音声ファイルを再生する React + TypeScript + Vite プロジェクトです。Netlify Functions を介して Google Drive API にアクセスします。

## 必要なもの

- Node.js 22.23.4 以上の 22 系（`.node-version` / `.nvmrc` 参照）
- npm

## 環境設定

1. リポジトリのクローン

   ```bash
   git clone https://github.com/kys0105/drive-player
   cd drive-player
   ```

2. 依存関係のインストール

   ```bash
   npm ci
   ```

3. 環境変数の設定

   `.env.example` を `.env` にコピーし、次のコマンドで新しいログイン用パスワードを設定してください。入力は非表示で、パスワードそのものは保存しません。

   ```bash
   npm run auth:setup
   ```

   16文字以上の新しいパスワードを使ってください。以前のブラウザ内固定パスワードはソースに含まれていたため、再利用しないでください。コマンドは `APP_PASSWORD_HASH`（scrypt形式）と `SESSION_SECRET`（ランダムな署名鍵）を `.env` に保存します。既存の認証設定を上書きしません。

   続けて `.env` に Google Drive の設定を記述します。

   ```env
   GOOGLE_SERVICE_ACCOUNT=...       # または GOOGLE_SERVICE_ACCOUNT_BASE64
   FOLDER_ID=Google Drive のフォルダ ID
   ```

   `GOOGLE_SERVICE_ACCOUNT` には Google Cloud で取得したサービスアカウントの JSON を直接記載するか、Base64 でエンコードした内容を `GOOGLE_SERVICE_ACCOUNT_BASE64` に設定します。`FOLDER_ID` は再生対象フォルダの ID です。サービスアカウントには、このフォルダだけを閲覧できる権限を与えてください。

   秘密情報を `VITE_` で始まる環境変数にしないでください。`.env` と `.env.*` は `.env.example` を除いて Git 管理対象外です。

4. Netlify CLI のインストール（任意）

   ```bash
   npm install -g netlify-cli
   netlify login
   ```

## 開発

- 開発サーバー

  ```bash
  npm run dev
  ```

  Vite単体はフロントエンドのみです。ログイン・一覧・音声再生の確認には、下記の `netlify dev` を使ってください。

- Netlify Functions と同時に起動

  ```bash
  netlify dev
  ```

## よく使うコマンド

| コマンド          | 説明                                      |
| ----------------- | ----------------------------------------- |
| `npm run lint`    | ESLint による静的解析                     |
| `npm run build`   | TypeScript をビルドし Vite で成果物を作成 |
| `npm run preview` | ビルド済みアプリのローカルプレビュー      |
| `npm run test:security` | 認証・取得制限・キャッシュの回帰テスト |
| `npm run auth:setup` | 非表示入力でローカルの認証設定を作成 |

## Netlifyへの反映

デプロイ前に、Netlify側にも `APP_PASSWORD_HASH`、`SESSION_SECRET`、`FOLDER_ID`、サービスアカウントの環境変数を設定してください。スコープを選べるプランではFunctionsスコープに限定します。スコープ指定に対応しないプランでは標準スコープを使い、`VITE_`接頭辞を付けず、フロントエンドのソースから参照しないでください。値をソースやビルド成果物へ埋め込まないでください。未設定時は認証APIが503となり、Driveへのアクセスを拒否します。

`netlify.toml` はビルド用Node.jsを22.23.4に指定します。Functionsの実行Node.jsはNetlify/AWSが管理するため、本番側のパッチ適用状況を別途確認してください。既存の `AWS_LAMBDA_JS_RUNTIME` 設定がある場合は、その上書き内容も確認します。[Netlifyの実行環境設定](https://docs.netlify.com/build/functions/configuration/#nodejs-version-for-runtime)

## 認証と音声キャッシュ

- パスワードはサーバーで検証します。ログイン状態は署名付きのHttpOnly Cookieに最大30日間保存し、本番ではHTTPS専用・SameSite=Strictです。HTTP開発はlocalhostのみに対応します。
- `list` と `stream` はリクエストごとに認証します。`stream` は `FOLDER_ID` 直下の、削除されていない `audio/mpeg` ファイルだけ取得します。
- ログインAPIは `/api/login` です。Netlifyのレート制限で、同一IP・ドメインからの試行を60秒あたり10回に制限します。このEdge側制限はユニットテストやローカルモックサーバーでは再現しません。
- APIと音声のHTTPレスポンスは `private, no-store` とし、共有CDNやブラウザのHTTPキャッシュに保存させません。Service Workerだけが、認証セッション別の音声キャッシュを管理します。
- Service Workerはキャッシュを返す前にもサーバーへ認証確認します。**オフライン再生はできません。** Rangeリクエストは認証後にネットワークへ転送し、音声の断片は保存しません。
- 初回更新時に旧音声キャッシュを削除するため、再ログインと音声の再取得が必要です。ログアウトすると再生を停止し、音声キャッシュを削除します。
- `APP_PASSWORD_HASH`、`SESSION_SECRET`、`FOLDER_ID` の変更は既存セッションを無効化します。署名付きCookie方式ではログアウトはそのブラウザのCookieを削除します。漏洩が疑われるCookieを全端末で失効させる場合は、サーバーの署名鍵を更新し再デプロイしてください。

## セキュリティ検証

```bash
npm run test:security
npm run lint
npm run build
npm audit
```

回帰テストは本番APIコードを読み込み、Google Driveと音声の上流通信だけをモック化します。未認証・Cookie改ざん/期限切れ・CSRF・フォルダ外/非音声ファイル・Range/HEAD・Service Workerの認証とログアウト競合を検証します。本番の環境変数、Drive共有権限、Netlify Edgeのレート制限は別途確認が必要です。
