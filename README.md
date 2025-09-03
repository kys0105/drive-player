# Drive Player

Google ドライブ上の音声ファイルを再生する React + TypeScript + Vite プロジェクトです。Netlify Functions を介して Google Drive API にアクセスします。

## 必要なもの

- Node.js 20 以上
- npm

## 環境設定

1. リポジトリのクローン

   ```bash
   git clone <REPO_URL>
   cd drive-player
   ```

2. 依存関係のインストール

   ```bash
   npm install
   ```

3. 環境変数の設定

   `.env` ファイルを作成し、次の変数を記述してください。

   ```env
   GOOGLE_SERVICE_ACCOUNT=...       # または GOOGLE_SERVICE_ACCOUNT_BASE64
   FOLDER_ID=Google Drive のフォルダ ID
   ```

   `GOOGLE_SERVICE_ACCOUNT` には Google Cloud で取得したサービスアカウントの JSON を直接記載するか、Base64 でエンコードした内容を `GOOGLE_SERVICE_ACCOUNT_BASE64` に設定します。`FOLDER_ID` は再生対象フォルダの ID です。

4. Netlify CLI のインストール（任意）

   ```bash
   npm install -g netlify-cli
   ```

## 開発

- 開発サーバー

  ```bash
  npm run dev
  ```

- Netlify Functions と同時に起動

  ```bash
  netlify dev
  ```

## よく使うコマンド

| コマンド            | 説明                                      |
| ------------------- | ----------------------------------------- |
| `npm run lint`      | ESLint による静的解析                     |
| `npm run build`     | TypeScript をビルドし Vite で成果物を作成 |
| `npm run preview`   | ビルド済みアプリのローカルプレビュー     |

Netlify へデプロイする場合も同じ環境変数を設定してください。

