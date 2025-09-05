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
- 固定パスワードによる簡易認証を行います。
- 認証が成功すると `localStorage` にフラグを保存し、次回以降は自動ログインします。

## 画面構成
### 1. ログイン画面
- パスワードを入力するフォームを提供し、固定値と一致する場合のみログインを許可します。

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
- `useCacheSync` フックが Cache Storage と取得したリストを比較し、未キャッシュの音声だけを `stream` から順次取得して保存します。
- 再生時は Service Worker が Cache Storage を参照し、音声が存在すれば API 通信を行いません。存在しない場合やバージョンが異なる場合のみ `stream` へ通信して音声を取得し、キャッシュを更新します。
- Service Worker は `/.netlify/functions/stream/` 以下のリクエストを cache-first で処理し、クエリ `?v=` により音声ファイルのバージョンを管理して更新時に古いキャッシュを削除します。

## Netlify Functions
### list
- 指定フォルダ内の音声ファイルを列挙し、ID、タイトル、MIME、サムネイル、バージョン情報などを返却します。

### stream
- Google Drive API 経由でファイルを取得し、Range リクエストに対応したままクライアントへ転送します。
- バージョン情報が存在する場合は `Cache-Control: public, max-age=31536000, immutable` を付与します。

## 環境変数
- `GOOGLE_SERVICE_ACCOUNT` または `GOOGLE_SERVICE_ACCOUNT_BASE64`: サービスアカウントの認証情報
- `FOLDER_ID`: 再生対象となる Google Drive フォルダ ID

## その他
- Service Worker 登録時に既存キャッシュを整理し、Storage API の永続化も要求します。
- 音声 MIME タイプは拡張子または Google Drive の `mimeType` から推測します。

