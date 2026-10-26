# Drive Player 設計書

## 概要
- Google ドライブ上の音声ファイルを再生するシングルページアプリケーションです。
- React, TypeScript, Vite を用いてフロントエンドを構成し、Netlify Functions を通じて Google Drive API に接続します。

## システム構成
- **フロントエンド**: React + TypeScript + Vite
- **UI ライブラリ**: Material UI
- **ドラッグ&ドロップ**: @dnd-kit
- **バックエンド**: Netlify Functions（list, stream）
- **キャッシュ**: Service Worker と Cache Storage

## 認証
- パスワードはサーバー上のscryptハッシュと照合し、署名付きHttpOnly Cookieで最大30日間ログイン状態を維持します。
- 起動時にsession APIで認証を確認し、list/streamも毎回認証します。パスワードハッシュ・署名鍵・対象フォルダを変更すると既存セッションは失効します。

## 画面構成
### 1. ログイン画面
- パスワードを入力するフォームを提供し、`/api/login`でサーバーが検証します。Netlify側でログイン試行回数を制限します。

### 2. プレイヤー画面
- トラック情報の取得、再生、プレイリスト表示を行います。
- ユーザーは楽曲の並べ替えや選択を行えます。

## 動作フロー
1. ログイン済みでない場合はログイン画面を表示します。
2. ログイン完了後、Netlify Function `list` を呼び出し楽曲一覧を取得します。
3. 取得したトラック配列を状態として保持し、先頭の曲を初期選択します。
4. 再生ボタン押下時にオーディオ要素へストリーム URL を設定して再生します。
5. 前後の曲への移動、シーク操作、Media Session API を利用した OS ネイティブ操作に対応します。
6. プレイリストはドラッグ&ドロップで並び替え可能です。再生中インデックスは自動調整します。

## キャッシュ戦略と API 通信
- ログイン完了後は Netlify Function `list` に必ず通信し、最新の曲一覧とバージョン情報を取得します。
- `useCacheSync` フックがセッション別のCache Storageと取得リストを比較し、未キャッシュの音声だけを `stream` から順次取得します。
- Service Workerは毎回session APIへ問い合わせ、認証が有効な場合だけセッション別キャッシュを返します。オフライン時にはキャッシュを返しません。
- `/.netlify/functions/stream/` の同一オリジンGETリクエストのうち、Rangeなし・`?v=`付き・200レスポンスだけ保存します。RangeとHEADは認証後にネットワークへ送ります。
- ログアウト時には音声を停止し、進行中の書き込みを無効化してから音声キャッシュを削除します。

## Netlify Functions
### list
- 指定フォルダ内の音声ファイルを列挙し、ID、タイトル、MIME、サムネイル、バージョン情報などを返却します。

### stream
- Google Drive API 経由でファイルを取得し、Range リクエストに対応したままクライアントへ転送します。
- 対象フォルダの親ID・音声MIME・削除状態を検証してから転送します。すべてのAPIレスポンスを `Cache-Control: private, no-store` とします。

## 環境変数
- `GOOGLE_SERVICE_ACCOUNT` または `GOOGLE_SERVICE_ACCOUNT_BASE64`: サービスアカウントの認証情報
- `FOLDER_ID`: 再生対象となる Google Drive フォルダ ID
- `APP_PASSWORD_HASH`: scrypt形式のパスワードハッシュ（`npm run auth:setup`で生成）
- `SESSION_SECRET`: セッション署名鍵（同コマンドで生成）

## その他
- Service Worker 登録時に既存キャッシュを整理し、Storage API の永続化も要求します。
- 音声 MIME タイプは拡張子または Google Drive の `mimeType` から推測します。

