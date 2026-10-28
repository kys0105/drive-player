import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ParsedLyrics } from './parse.ts';
import { activeLyricIndex, readLyricsMode, resolveLyricsMode, storeLyricsMode, type LyricsMode } from './viewModel.ts';
import './lyrics.css';

export type LyricsViewProps = {
  lyrics: ParsedLyrics | null;
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
  onAddLyrics: () => void;
  trackKey?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

function accessibleTime(time: number) {
  const seconds = Math.max(0, Math.floor(time));
  return Math.floor(seconds / 60) + '分' + seconds % 60 + '秒';
}

export default function LyricsView({ lyrics, currentTime, duration, onSeek, onAddLyrics, trackKey, loading = false, error, onRetry }: LyricsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialScroll = useRef(true);
  const pointerStart = useRef<number | null>(null);
  const fullScroll = useRef(0);
  const [following, setFollowing] = useState(true);
  const [preferred, setPreferred] = useState<LyricsMode | null>(readLyricsMode);
  const headingId = useId();
  const lines = lyrics?.lines ?? [];
  const mode = resolveLyricsMode(Boolean(lyrics?.synced), preferred);
  const activeIndex = lyrics?.synced ? activeLyricIndex(lines, currentTime) : -1;
  const documentKey = trackKey ?? lyrics?.fullText ?? '';
  function changeMode(next: LyricsMode) {
    if (next === mode || (next === 'follow' && !lyrics?.synced)) return;
    if (mode === 'full') fullScroll.current = scrollRef.current?.scrollTop ?? 0;
    initialScroll.current = true;
    setFollowing(true);
    setPreferred(next);
    storeLyricsMode(next);
  }

  useLayoutEffect(() => {
    initialScroll.current = true;
    fullScroll.current = 0;
    setFollowing(true);
  }, [documentKey, lyrics?.fullText]);

  useLayoutEffect(() => {
    if (mode === 'full' && scrollRef.current) scrollRef.current.scrollTop = fullScroll.current;
  }, [mode, documentKey, lyrics?.fullText]);

  useEffect(() => {
    if (mode !== 'follow' || !following || !lyrics?.synced || activeIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      const line = lineRefs.current[activeIndex];
      if (!scroll || !line) return;
      const lineTop = line.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scroll.scrollTo({
        top: Math.max(0, scroll.scrollTop + lineTop - scroll.clientHeight * 0.34),
        behavior: initialScroll.current || reduceMotion ? 'instant' : 'smooth',
      });
      initialScroll.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, following, lyrics, mode]);

  return (
    <section className="lyrics-view" aria-labelledby={headingId}>
      <h2 id={headingId} className="lyrics-sr">歌詞</h2>
      <div className="lyrics-toolbar">
        <div className="lyrics-modes" role="group" aria-label="歌詞の表示方法">
          <button type="button" aria-pressed={mode === 'follow'} disabled={!lyrics?.synced} onClick={() => changeMode('follow')}>追従</button>
          <button type="button" aria-pressed={mode === 'full'} onClick={() => changeMode('full')}>全文</button>
        </div>
        {lyrics && !lyrics.synced && <p className="lyrics-caption">タイミング情報なし</p>}
        {lines.length > 0 && (loading || error) && <p className="lyrics-status" role={error ? 'alert' : 'status'}>{error || '歌詞を更新しています…'}{error && onRetry && <button type="button" onClick={onRetry}>再試行</button>}</p>}
      </div>
      {!lines.length ? <div className="lyrics-empty" role={error ? 'alert' : 'status'}>
        <h3>{loading ? '歌詞を読み込んでいます…' : error ? '歌詞を取得できませんでした' : 'この曲の歌詞はまだありません'}</h3>
        <p>{error || (loading ? '音源の再生は続けられます。' : '歌詞を貼り付けるか、TXT・LRCファイルから追加できます。')}</p>
        {!loading && error && onRetry && <button type="button" className="lyrics-add" onClick={onRetry}>再試行</button>}
        {!loading && <button type="button" className="lyrics-add" onClick={onAddLyrics}>この端末に歌詞を追加</button>}
      </div> : <div
        ref={scrollRef}
        className="lyrics-scroll"
        tabIndex={0}
        aria-label="歌詞をスクロール"
        onScroll={() => { if (mode === 'full') fullScroll.current = scrollRef.current?.scrollTop ?? 0; }}
        onPointerDown={(event) => { pointerStart.current = event.clientY; }}
        onPointerMove={(event) => {
          if (pointerStart.current !== null && Math.abs(event.clientY - pointerStart.current) > 8) setFollowing(false);
        }}
        onPointerUp={() => { pointerStart.current = null; }}
        onPointerCancel={() => { pointerStart.current = null; }}
        onTouchMove={() => { setFollowing(false); }}
        onWheel={() => { setFollowing(false); }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) setFollowing(false);
        }}
      >
        {mode === 'full' ? <div className="lyrics-full">{lyrics?.fullText}</div> : <div className="lyrics-lines">
          {lines.map((line, index) => line.time !== null && lyrics?.synced ? (
            <button
              key={index + ':' + line.time}
              ref={(element) => { lineRefs.current[index] = element; }}
              type="button"
              className={'lyrics-line' + (index === activeIndex ? ' lyrics-line--active' : '')}
              aria-current={index === activeIndex ? 'true' : undefined}
              aria-label={line.text + '、' + accessibleTime(line.time) + 'から再生'}
              onClick={() => {
                setFollowing(true);
                onSeek(Math.min(Math.max(0, duration), Math.max(0, line.time ?? 0)));
              }}
            >{line.text}</button>
          ) : <p key={index + ':plain'} className="lyrics-line lyrics-line--plain">{line.text}</p>)}
        </div>}
      </div>}
      {mode === 'follow' && lyrics?.synced && !following && activeIndex >= 0 && (
        <button type="button" className="lyrics-follow" onClick={() => { setFollowing(true); }}>再生中の歌詞に戻る</button>
      )}
    </section>
  );
}
