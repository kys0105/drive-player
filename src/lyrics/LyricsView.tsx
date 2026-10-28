import { useEffect, useId, useRef, useState } from 'react';
import type { ParsedLyrics } from './parse.ts';
import './lyrics.css';

export type LyricsViewProps = {
  lyrics: ParsedLyrics | null;
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
  onAddLyrics: () => void;
};

function accessibleTime(time: number) {
  const seconds = Math.max(0, Math.floor(time));
  return Math.floor(seconds / 60) + '分' + seconds % 60 + '秒';
}

export default function LyricsView({ lyrics, currentTime, duration, onSeek, onAddLyrics }: LyricsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialScroll = useRef(true);
  const pointerStart = useRef<number | null>(null);
  const [following, setFollowing] = useState(true);
  const headingId = useId();
  const lines = lyrics?.lines ?? [];
  let activeIndex = -1;
  if (lyrics?.synced) {
    for (let index = 0; index < lines.length; index++) {
      const time = lines[index].time;
      if (time !== null && time <= currentTime) activeIndex = index;
    }
  }

  useEffect(() => {
    initialScroll.current = true;
    setFollowing(true);
  }, [lyrics]);

  useEffect(() => {
    if (!following || !lyrics?.synced || activeIndex < 0) return;
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
  }, [activeIndex, following, lyrics]);

  if (!lines.length) {
    return (
      <section className="lyrics-empty" aria-labelledby={headingId}>
        <h2 id={headingId}>この曲の歌詞はまだありません</h2>
        <p>歌詞を貼り付けるか、<br />TXT・LRCファイルから追加できます。</p>
        <button type="button" className="lyrics-add" onClick={onAddLyrics}>歌詞を追加</button>
      </section>
    );
  }

  return (
    <section className="lyrics-view" aria-labelledby={headingId}>
      <h2 id={headingId} className="lyrics-sr">歌詞</h2>
      <p className="lyrics-caption">{lyrics?.synced ? '再生に合わせて表示' : 'タイミング情報なし'}</p>
      <div
        ref={scrollRef}
        className="lyrics-scroll"
        tabIndex={0}
        aria-label="歌詞をスクロール"
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
        <div className="lyrics-lines">
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
        </div>
      </div>
      {lyrics?.synced && !following && activeIndex >= 0 && (
        <button type="button" className="lyrics-follow" onClick={() => { setFollowing(true); }}>再生中の歌詞に戻る</button>
      )}
    </section>
  );
}
