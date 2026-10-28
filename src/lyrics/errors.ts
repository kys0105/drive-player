const NETWORK_MESSAGE = '歌詞を取得できませんでした。通信状態を確認して、もう一度お試しください。';

export function normalizeLyricsError(error: unknown): unknown {
  if (error instanceof Error && (error.name === 'NetworkError' ||
      /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_connection/i.test(error.message))) {
    return new Error(NETWORK_MESSAGE);
  }
  return error;
}

export function lyricsErrorMessage(error: unknown): string {
  const normalized = normalizeLyricsError(error);
  return normalized instanceof Error ? normalized.message : '歌詞を処理できませんでした。もう一度お試しください。';
}
