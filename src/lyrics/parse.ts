export type LyricLine = { time: number | null; text: string };

export type ParsedLyrics = { lines: LyricLine[]; synced: boolean; fullText: string };

export const MAX_LYRIC_CHARACTERS = 200_000;
export const MAX_LYRIC_LINES = 5_000;
const TIMESTAMP = /\[(\d{1,4}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const METADATA = /\[(?:ar|ti|al|by|au|length|re|ve|tool|id|offset):[^\]]*\]/gi;

export function parseLyrics(input: string): ParsedLyrics {
  if (input.includes('\0')) throw new Error('歌詞をテキスト形式で保存してください。');
  if (input.length > MAX_LYRIC_CHARACTERS) {
    throw new Error('歌詞が長すぎます。20万文字以内にしてください。');
  }
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const sourceLines = source.split('\n');
  if (sourceLines.length > MAX_LYRIC_LINES) throw new Error('歌詞の行数が多すぎます。5,000行以内にしてください。');
  let offset = 0;
  for (const match of source.matchAll(/\[offset:\s*([+-]?\d+)\s*\]/gi)) {
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) throw new Error('LRCの時刻補正値を確認してください。');
    offset = value / 1_000;
  }
  const timed: Array<LyricLine & { order: number }> = [];
  const plain: LyricLine[] = [];
  const originalLines: string[] = [];
  let order = 0;
  for (const raw of sourceLines) {
    const withoutMetadata = raw.replace(METADATA, '');
    const line = withoutMetadata.trim();
    // Metadata does not create paragraphs. Actual blank lines remain in the full text.
    if (line || !raw.trim() || withoutMetadata === raw) originalLines.push(withoutMetadata.replace(TIMESTAMP, ''));
    if (!line) continue;
    const tags = [...line.matchAll(TIMESTAMP)];
    if (!tags.length) {
      if (/^\[\d+:\d/.test(line)) throw new Error('LRCの時刻は [分:秒.小数] の形式にしてください。');
      plain.push({ time: null, text: line });
    } else {
      const text = line.replace(TIMESTAMP, '').trim();
      if (!text) continue;
      for (const tag of tags) {
        const seconds = Number(tag[2]);
        if (seconds >= 60) throw new Error('LRCの秒数は00から59の範囲にしてください。');
        const fraction = tag[3] ? Number('0.' + tag[3]) : 0;
        timed.push({ time: Math.max(0, Number(tag[1]) * 60 + seconds + fraction - offset), text, order: order++ });
      }
    }
    if (timed.length + plain.length > MAX_LYRIC_LINES) {
      throw new Error('歌詞の行数が多すぎます。5,000行以内にしてください。');
    }
  }
  if (timed.length && plain.length) {
    throw new Error('時刻付きの行と時刻のない歌詞が混在しています。全行に時刻を付けるか、時刻を外して通常のテキストとして読み込んでください。');
  }
  while (originalLines.length && !originalLines[0].trim()) originalLines.shift();
  while (originalLines.length && !originalLines[originalLines.length - 1].trim()) originalLines.pop();
  const fullText = originalLines.join('\n');
  if (!timed.length) return { lines: plain, synced: false, fullText };
  timed.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.order - b.order);
  return { lines: timed.map(({ time, text }) => ({ time, text })), synced: true, fullText };
}

export async function readLyricsFile(file: File): Promise<string> {
  if (!/\.(?:txt|lrc)$/i.test(file.name)) throw new Error('TXTまたはLRCファイルを選んでください。');
  if (file.size > MAX_LYRIC_CHARACTERS * 4) throw new Error('歌詞ファイルが大きすぎます。');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error('UTF-8形式の歌詞ファイルを選んでください。');
  }
  if (text.includes('\0')) throw new Error('歌詞をテキスト形式で保存してから選んでください。');
  return text;
}
