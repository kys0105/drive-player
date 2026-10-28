import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Track } from '../types';
import type { AuthSession } from '../utils/session';
import { deleteSavedTrack, downloadTrack } from '../utils/cache';
import type { DownloadProgress } from '../utils/cache';
import { usePlayback } from '../hooks/usePlayback';
import { useLibrary } from '../hooks/useLibrary';
import { cacheDriveLyrics, LyricsEditor, LyricsView, useTrackLyrics } from '../lyrics';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { artwork, formatBytes, formatTime, preferredTracks } from './music';
import Sheet from './Sheet';

type Props = { cacheScope: string; session: AuthSession; onSessionExpired: () => void; onLogout: () => void };
type SheetName = 'track' | 'settings' | 'order' | 'lyrics' | 'queue' | 'albums' | null;
const artist = (track?: Track) => track?.artist || 'SetagayaGenico';
const sameVersion = (a: Track, b: Track) => a.id === b.id && (a.ver ?? '') === (b.ver ?? '');
function IconButton({ name, label, onClick, size = 24, fill = false, active = false, disabled = false, className = '' }:
  { name: IconName; label: string; onClick: () => void; size?: number; fill?: boolean; active?: boolean; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${active ? 'is-active' : ''} ${className}`} aria-label={label} aria-pressed={active || undefined} disabled={disabled} onClick={onClick}><Icon name={name} size={size} fill={fill} /></button>;
}

export default function PlayerScreen({ cacheScope, session, onSessionExpired, onLogout }: Props) {
  const [online, setOnline] = useState(navigator.onLine);
  const library = useLibrary(cacheScope, online, onSessionExpired);
  const { tracks, setTracks, saved, refreshSaved, loading: listLoading, error: listError } = library;
  const [queue, setQueue] = useState<{ albumId: string; tracks: Track[] }>({ albumId: '', tracks: [] });
  const [query, setQuery] = useState('');
  const [onlySaved, setOnlySaved] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(/^#(?:player|lyrics)$/.test(location.hash));
  const [lyricsOpen, setLyricsOpen] = useState(location.hash === '#lyrics');
  const [sheet, setSheet] = useState<SheetName>(null);
  const [sheetTrackId, setSheetTrackId] = useState('');
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [toast, setToast] = useState('');
  const controllers = useRef(new Map<string, AbortController>());
  const bulkStop = useRef(false), bulkCurrent = useRef(''), mounted = useRef(true);
  const playerRoot = useRef<HTMLElement>(null), miniOpen = useRef<HTMLButtonElement>(null);
  const offline = !online || Boolean(session.offline);
  const notify = useCallback((message: string) => setToast(message), []);
  const isSaved = useCallback((track: Track) => saved.some(item => sameVersion(item, track)), [saved]);
  const savedIds = useMemo(() => new Set(queue.tracks.filter(isSaved).map(track => track.id)), [queue.tracks, isSaved]);
  const playback = usePlayback({ tracks: queue.tracks, offline, savedIds, isSaved, onSessionExpired, notify });
  const { activeTrack: track, trackId, playing, loading, position, duration } = playback;
  const showPlayer = playerOpen && Boolean(track);
  const selected = tracks.find(item => item.id === sheetTrackId) ?? queue.tracks.find(item => item.id === sheetTrackId) ?? track;
  const lyricTrack = sheet === 'lyrics' ? selected : track;
  const lyrics = useTrackLyrics(lyricTrack ? { scope: cacheScope, trackId: lyricTrack.id, version: lyricTrack.ver ?? '' } : null,
    { asset: lyricTrack?.lyrics, issue: lyricTrack?.lyricsIssue, offline, enabled: showPlayer && lyricsOpen || sheet === 'lyrics', onSessionExpired });
  const currentIndex = queue.tracks.findIndex(item => item.id === trackId);
  const nextTracks = queue.tracks.slice(currentIndex + 1).filter(item => !offline || isSaved(item));
  const nextTrack = nextTracks[0] ?? (playback.repeat === 'all' ? queue.tracks.find(item => !offline || isSaved(item)) : undefined);
  const visibleTracks = tracks.filter(item => (!onlySaved || isSaved(item)) && `${item.title} ${artist(item)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  useEffect(() => {
    mounted.current = true;
    const downloads = controllers.current;
    return () => { mounted.current = false; bulkStop.current = true; for (const controller of downloads.values()) controller.abort(); };
  }, []);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4200); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!tracks.length) return;
    setQueue(previous => !previous.tracks.length || previous.albumId === library.albumId ? { albumId: library.albumId, tracks } : previous);
  }, [tracks, library.albumId]);
  useEffect(() => {
    const update = () => { setPlayerOpen(/^#(?:player|lyrics)$/.test(location.hash)); setLyricsOpen(location.hash === '#lyrics'); };
    window.addEventListener('popstate', update); return () => window.removeEventListener('popstate', update);
  }, []);
  useEffect(() => {
    history.replaceState(null, '', location.pathname + location.search + (playerOpen ? lyricsOpen ? '#lyrics' : '#player' : ''));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', showPlayer ? '#0b1725' : '#ffffff');
    if (playerOpen) playerRoot.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [playerOpen, lyricsOpen, showPlayer]);

  function openSheet(name: SheetName, id = trackId) { (document.activeElement as HTMLElement | null)?.blur(); setSheetTrackId(id); setSheet(name); }
  function openPlayer(showLyrics = false) { (document.activeElement as HTMLElement | null)?.blur(); setLyricsOpen(showLyrics); setPlayerOpen(true); }
  function closePlayer() { setPlayerOpen(false); requestAnimationFrame(() => miniOpen.current?.focus({ preventScroll: true })); }
  function saveOrder(items: Track[]) { setTracks(items); }
  function moveTrack(id: string, step: number) { const from = tracks.findIndex(item => item.id === id), to = from + step; if (to < 0 || to >= tracks.length) return; const items = [...tracks]; [items[from], items[to]] = [items[to], items[from]]; saveOrder(items); }
  async function download(item: Track): Promise<boolean> {
    if (controllers.current.has(item.id)) return false;
    if (offline) { notify('曲の保存にはオンライン接続が必要です。'); return false; }
    const controller = new AbortController(); controllers.current.set(item.id, controller);
    setSaveErrors(previous => ({ ...previous, [item.id]: '' })); setProgress(previous => ({ ...previous, [item.id]: { loaded: 0, total: item.size } }));
    try {
      if (!isSaved(item)) await downloadTrack(item, cacheScope, { signal: controller.signal, onProgress: value => { if (mounted.current) setProgress(previous => ({ ...previous, [item.id]: value })); } });
      await refreshSaved();
      try { await cacheDriveLyrics(item, cacheScope, { signal: controller.signal, onSessionExpired }); }
      catch (failure) {
        if (controller.signal.aborted) return false;
        const message = failure instanceof Error ? failure.message : '歌詞を保存できませんでした。';
        if (mounted.current) { setSaveErrors(previous => ({ ...previous, [item.id]: message })); notify(item.title + 'の音源は保存済みですが、歌詞を保存できませんでした。'); }
        return false;
      }
      if (mounted.current) notify(item.title + 'を端末に保存しました。'); return true;
    } catch (failure) {
      if (controller.signal.aborted || !mounted.current) return false;
      const message = failure instanceof DOMException && failure.name === 'QuotaExceededError' ? '端末の空き容量が足りません。保存済みの曲を削除して再試行してください。' : failure instanceof Error ? failure.message : '保存できませんでした。もう一度お試しください。';
      setSaveErrors(previous => ({ ...previous, [item.id]: message })); notify(message); if (/ログインの有効期限/.test(message)) onSessionExpired(); return false;
    } finally { controllers.current.delete(item.id); if (mounted.current) setProgress(previous => { const next = { ...previous }; delete next[item.id]; return next; }); }
  }
  async function toggleSave(item: Track) {
    if (controllers.current.has(item.id)) { controllers.current.get(item.id)?.abort(); notify('保存を取り消しました。'); return; }
    if (isSaved(item) && !saveErrors[item.id]) { try { await deleteSavedTrack(item, cacheScope); await refreshSaved(); notify('この端末の保存音源を削除しました。'); } catch (failure) { notify(failure instanceof Error ? failure.message : '保存音源を削除できませんでした。'); } }
    else await download(item);
  }
  async function saveAll() {
    if (bulkSaving) { bulkStop.current = true; controllers.current.get(bulkCurrent.current)?.abort(); return; }
    bulkStop.current = false; setBulkSaving(true);
    for (const item of tracks) { if (bulkStop.current || !mounted.current) break; bulkCurrent.current = item.id; if (!(await download(item))) break; }
    bulkCurrent.current = ''; if (mounted.current) setBulkSaving(false);
  }
  function chooseLibraryTrack(item: Track, autoPlay = true) {
    if (offline && !isSaved(item)) { notify('この曲は端末に保存されていません。'); return; }
    setQueue({ albumId: library.albumId, tracks });
    playback.chooseTrack(item.id, autoPlay, tracks);
  }
  function showLyrics(item: Track) { if (item.id !== trackId) chooseLibraryTrack(item, false); setSheet(null); openPlayer(true); }
  function cycleRepeat() { const repeat = playback.repeat === 'none' ? 'all' : playback.repeat === 'all' ? 'one' : 'none'; playback.setRepeat(repeat); notify(repeat === 'one' ? '1曲をリピートします。' : repeat === 'all' ? '全曲をリピートします。' : '曲順に再生します。'); }
  function trapFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); closePlayer(); return; } if (event.key !== 'Tab') return;
    const items = [...(playerRoot.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const saveName = (item: Track): IconName => progress[item.id] ? 'loading' : isSaved(item) ? 'saved' : 'download';
  const saveLabel = (item: Track) => progress[item.id] ? `${item.title}の保存を取り消す` : isSaved(item) ? `${item.title}の保存済みメニュー` : `${item.title}を端末に保存`;
  const savingLabel = (item: Track) => { const value = progress[item.id]; return value?.total ? `保存中 ${Math.min(99, Math.floor(value.loaded / value.total * 100))}%` : '保存中…'; };
  const endTime = duration > 0 ? formatTime(duration) : '--:--';

  return <main className={`music-app ${showPlayer ? 'is-player-open' : ''}`}>
    <audio ref={playback.audioRef} preload="metadata" playsInline />
    <section className="library-screen" aria-label="ライブラリ" inert={showPlayer || undefined} style={{ visibility: showPlayer ? 'hidden' : 'visible' }}>
      <header className="library-header"><div className="brand-line"><span>SetagayaGenico</span><IconButton name="settings" label="設定を開く" onClick={() => openSheet('settings')} size={25} /></div><div className="library-title-row"><h1>ライブラリ</h1><button type="button" className="album-picker" aria-label="フォルダを選択" onClick={() => openSheet('albums')}><span>{library.album?.name ?? 'フォルダを選択'}</span><Icon name="down" size={16} /></button></div><div className="search-field"><Icon name="search" size={21} /><input aria-label="曲を検索" type="search" placeholder="曲を検索" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />{query && <IconButton name="close" label="検索をクリア" onClick={() => setQuery('')} size={18} />}</div><div className="library-filters" role="group" aria-label="曲の表示"><button type="button" aria-pressed={!onlySaved} onClick={() => setOnlySaved(false)}>すべて</button><button type="button" aria-pressed={onlySaved} onClick={() => setOnlySaved(true)}>保存済み</button></div>{offline && <div className="offline-note"><Icon name="offline" size={16} />保存した曲を聴けます</div>}</header>
      <div className="library-list-region"><div className="song-scroll"><div className="song-list" role="list" aria-label={onlySaved ? '保存した曲' : 'すべての曲'}>
        {listError && <div className="catalog-message" role="status">{listError}<button type="button" onClick={library.refresh}>再試行</button></div>}
        {listLoading && !tracks.length && <div className="empty-library" role="status"><Icon name="loading" className="spin" /><p>曲を読み込んでいます…</p></div>}
        {visibleTracks.map(item => <div className={`song-row ${item.id === trackId ? 'is-current' : ''}`} key={item.id} role="listitem"><button type="button" className="song-select" aria-label={`${item.title}${item.id === trackId ? '、再生画面を開く' : 'を再生'}`} aria-disabled={offline && !isSaved(item) || undefined} onClick={() => item.id === trackId ? openPlayer() : chooseLibraryTrack(item)}><img src={artwork(item)} alt="" className="song-art" draggable={false} loading="lazy" /><span className="song-metadata"><span className="song-title">{item.id === trackId && <Icon name="music" fill size={16} />}{item.title}</span><span className="song-artist">{artist(item)}</span>{progress[item.id] && <span className="song-save-status">{savingLabel(item)}</span>}{saveErrors[item.id] && <span className="song-save-error">保存失敗・メニューから再試行</span>}</span></button>{(isSaved(item) || progress[item.id]) && <IconButton name={saveName(item)} label={saveLabel(item)} onClick={() => progress[item.id] ? void toggleSave(item) : openSheet('track', item.id)} size={20} fill={isSaved(item)} className={`row-save ${progress[item.id] ? 'is-saving' : ''}`} />}<IconButton name="more" label={`${item.title}のメニュー`} onClick={() => openSheet('track', item.id)} size={23} /></div>)}
        {!listLoading && !visibleTracks.length && <div className="empty-library"><Icon name={onlySaved ? 'download' : 'search'} size={36} /><h2>{query ? '曲が見つかりません' : onlySaved ? '保存した曲はまだありません' : '曲がありません'}</h2><p>{query ? '別の曲名で検索してみてください。' : onlySaved ? '曲のメニューから端末に保存できます。' : 'オンラインで曲一覧を更新してください。'}</p>{(query || onlySaved) && <button type="button" onClick={() => { setQuery(''); setOnlySaved(false); }}>すべての曲へ</button>}</div>}
      </div></div></div>
      <footer className="library-footer">{track && <div className="mini-player" aria-label="再生中の曲"><button type="button" className="mini-track" onClick={() => openPlayer()} ref={miniOpen} aria-label={`${track.title}の再生画面を開く`}><img src={artwork(track)} alt="" /><span><strong>{track.title}</strong><small>{loading ? '読み込み中…' : artist(track)}</small></span></button><IconButton name={playing ? 'pause' : loading ? 'loading' : 'play'} label={playing ? '一時停止' : loading ? '読み込みを中止' : '再生'} onClick={playback.togglePlayback} fill size={27} className={loading ? 'is-saving' : ''} /><IconButton name="next" label="次の曲" onClick={() => playback.next()} fill size={25} /><div className="mini-progress"><progress value={position} max={duration || 1} aria-label="再生の進み具合" /><div><span>{formatTime(position)}</span><span>{endTime}</span></div></div></div>}<nav className="library-nav" aria-label="メインナビゲーション"><button type="button" className={!onlySaved ? 'active' : ''} aria-current={!onlySaved ? 'page' : undefined} onClick={() => setOnlySaved(false)}><Icon name="music" fill size={26} /><span>ライブラリ</span></button><button type="button" className={onlySaved ? 'active' : ''} aria-current={onlySaved ? 'page' : undefined} onClick={() => setOnlySaved(true)}><Icon name="download" size={26} /><span>保存済み</span></button></nav></footer>
    </section>
    {playerOpen && track && <section ref={playerRoot} className={`player-screen ${lyricsOpen ? 'lyrics-mode' : ''}`} role="dialog" aria-modal="true" aria-label={lyricsOpen ? '歌詞と再生操作' : '再生中'} onKeyDown={trapFocus}><img className="player-backdrop" src={artwork(track)} alt="" /><div className="player-shade" /><div className="player-content"><header className="player-header"><IconButton name="down" label="再生画面を閉じる" onClick={closePlayer} size={27} />{lyricsOpen ? <div className="compact-track"><img src={artwork(track)} alt="" /><span><strong>{track.title}</strong><small>{artist(track)}</small></span></div> : <div className="player-context"><span>{library.albums.find(album => album.id === queue.albumId)?.name ?? 'ライブラリ'}</span><small>{artist(track)}</small></div>}<IconButton name="more" label="再生中の曲のメニュー" onClick={() => openSheet('track')} size={26} /></header>
      {lyricsOpen ? <div className="player-lyrics-region">{lyrics.localAvailable && <div className="lyrics-source-picker" role="group" aria-label="歌詞の取得元"><button type="button" aria-pressed={lyrics.sourceChoice === 'drive'} onClick={() => lyrics.setSourceChoice('drive')}>Google Drive</button><button type="button" aria-pressed={lyrics.sourceChoice === 'local'} onClick={() => lyrics.setSourceChoice('local')}>この端末の歌詞</button></div>}<LyricsView trackKey={cacheScope + ":" + track.id} loading={lyrics.loading} error={lyrics.error} onRetry={() => { void lyrics.refresh().catch(() => {}); }} lyrics={lyrics.lyrics} currentTime={position} duration={duration} onSeek={seconds => playback.seek(seconds, true)} onAddLyrics={() => openSheet('lyrics')} /></div> : <div className="player-visual"><img className="player-cover" src={artwork(track)} alt={`${track.title}のアートワーク`} /><div className="player-track"><div><h2>{track.title}</h2><p>{artist(track)}</p></div><IconButton name={saveName(track)} label={saveLabel(track)} onClick={() => isSaved(track) ? openSheet('track') : void toggleSave(track)} size={26} active={isSaved(track)} className={progress[track.id] ? 'is-saving' : ''} /></div></div>}
      <div className="player-controls">{playback.error && <p className="playback-error" role="alert">{playback.error}</p>}<div className="seek-block"><input type="range" aria-label="再生位置" min={0} max={duration || 1} step={0.1} value={Math.min(position, duration || 1)} disabled={!duration} onChange={event => playback.seek(Number(event.target.value))} /><div className="seek-times"><span>{formatTime(position)}</span><span>{loading ? '読み込み中…' : endTime}</span></div></div><div className="transport"><IconButton name="previous" label="前の曲・曲の頭へ" onClick={playback.previous} fill size={35} /><IconButton name={playing ? 'pause' : loading ? 'loading' : 'play'} label={playing ? '一時停止' : loading ? '読み込みを中止' : '再生'} onClick={playback.togglePlayback} fill size={34} className={`main-play ${loading ? 'is-saving' : ''}`} /><IconButton name="next" label="次の曲" onClick={() => playback.next()} fill size={35} /></div><div className="player-tools"><IconButton name={playback.repeat === 'one' ? 'repeatOne' : 'repeat'} label={`リピート：${playback.repeat === 'one' ? '1曲' : playback.repeat === 'all' ? '全曲' : 'オフ'}`} onClick={cycleRepeat} active={playback.repeat !== 'none'} size={24} /><button type="button" className={`lyrics-toggle ${lyricsOpen ? 'active' : ''}`} aria-label={lyricsOpen ? 'ジャケットを表示' : '歌詞を表示'} aria-pressed={lyricsOpen} onClick={() => setLyricsOpen(!lyricsOpen)}><Icon name="lyrics" size={25} /><span>歌詞</span></button><IconButton name="queue" label="次に再生する曲を表示" onClick={() => openSheet('queue')} size={25} /></div>{!lyricsOpen && nextTrack && <button type="button" className="next-preview" onClick={() => openSheet('queue')}><span className="next-label">次に再生</span><img src={artwork(nextTrack)} alt="" /><span><strong>{nextTrack.title}</strong><small>{artist(nextTrack)}</small></span><Icon name="queue" size={20} /></button>}</div>
    </div></section>}
    <Sheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet === 'albums' ? 'フォルダを選択' : sheet === 'settings' ? '設定' : sheet === 'order' ? '曲順' : sheet === 'lyrics' ? 'この端末の歌詞を編集' : sheet === 'queue' ? '次に再生' : selected?.title ?? '曲のメニュー'}><div className="music-sheet">
      {sheet === 'track' && selected && <><div className="sheet-track"><img src={artwork(selected)} alt="" /><div><strong>{selected.title}</strong><span>{artist(selected)}</span></div></div>{saveErrors[selected.id] && <p className="import-error" role="alert">{saveErrors[selected.id]}</p>}<button type="button" onClick={() => { void toggleSave(selected); setSheet(null); }}><Icon name={saveName(selected)} />{progress[selected.id] ? '保存を取り消す' : saveErrors[selected.id] ? '保存を再試行' : isSaved(selected) ? '端末の保存を削除' : '端末に保存'}</button><button type="button" onClick={() => showLyrics(selected)}><Icon name="lyrics" />歌詞を表示</button>{isSaved(selected) && selected.lyrics && <button type="button" disabled={offline || Boolean(progress[selected.id])} onClick={() => { void download(selected); setSheet(null); }}><Icon name="download" />歌詞を更新して端末に保存</button>}<button type="button" onClick={() => setSheet('lyrics')}><Icon name="upload" />この端末の歌詞を読み込む・編集</button><button type="button" onClick={() => setSheet('order')}><Icon name="order" />曲順を変更</button></>}
      {sheet === 'albums' && <div className="album-list">{library.albums.map(album => <button type="button" className="album-option" key={album.id} aria-pressed={album.id === library.albumId} onClick={() => { library.selectAlbum(album.id); setQuery(''); setSheet(null); }}><span className="album-symbol"><Icon name="music" size={25} /></span><span><strong>{album.name}</strong><small>{offline ? '端末の曲一覧' : 'Google Drive'}</small></span>{album.id === library.albumId && <Icon name="saved" size={22} fill />}</button>)}{!library.albums.length && <p className="sheet-empty">{listLoading ? 'フォルダを読み込んでいます…' : 'フォルダが見つかりません。'}</p>}<button type="button" className="album-refresh" onClick={() => { library.refresh(); setSheet(null); }}><Icon name="restart" size={20} />フォルダと曲一覧を更新</button></div>}
      {sheet === 'settings' && <>{toast && <p className="sheet-feedback" role="status">{toast}</p>}<p className="settings-heading">このフォルダの保存</p><p className="settings-summary">{tracks.filter(item => isSaved(item)).length}曲を保存済み · {formatBytes(saved.filter(item => tracks.some(track => sameVersion(item, track))).reduce((sum, item) => sum + (item.size ?? 0), 0))}</p><button type="button" onClick={() => setSheet('order')}><Icon name="order" />曲順を変更</button><button type="button" disabled={offline && !bulkSaving} onClick={() => void saveAll()}><Icon name={bulkSaving ? 'close' : 'download'} />{bulkSaving ? 'まとめて保存を中止' : 'このフォルダの曲をまとめて保存'}</button><button type="button" onClick={() => { library.refresh(); void lyrics.refresh().catch(() => {}); setSheet(null); }}><Icon name="restart" />フォルダ・曲一覧・歌詞を更新</button><div className="settings-note"><strong>圏外での再生</strong><p>{session.offlineUntil ? `${new Date(session.offlineUntil).toLocaleString('ja-JP')}まで` : 'オンラインでログイン状態を確認してください。'}</p><p>保存した曲を、この端末で聴けます。ブラウザの保存データは端末によって削除されることがあります。</p><p>iPhoneでは「共有」から「ホーム画面に追加」すると、アプリとして開けます。</p></div><button type="button" className="logout-button" onClick={() => { playback.pause(); onLogout(); }}>ログアウトして、この端末の保存音源を削除</button></>}
      {sheet === 'order' && <><button type="button" className="preferred-order" onClick={() => { saveOrder(preferredTracks(tracks)); notify('ゆもしんの曲順にしました。'); }}><Icon name="order" />ゆもしんの曲順にする</button><div className="sheet-track-list">{tracks.map((item, index) => <div className="reorder-row" key={item.id}><span className="order-number">{index + 1}</span><span>{item.title}</span><IconButton name="up" label={`${item.title}を上に移動`} disabled={index === 0} onClick={() => moveTrack(item.id, -1)} size={19} /><IconButton name="moveDown" label={`${item.title}を下に移動`} disabled={index === tracks.length - 1} onClick={() => moveTrack(item.id, 1)} size={19} /></div>)}</div></>}
      {sheet === 'queue' && <div className="sheet-track-list">{nextTracks.map(item => <button type="button" className="queue-row" key={item.id} onClick={() => { playback.chooseTrack(item.id); setSheet(null); }}><img src={artwork(item)} alt="" /><span><strong>{item.title}</strong><small>{artist(item)}</small></span><Icon name="play" fill size={18} /></button>)}{!nextTracks.length && <p className="sheet-empty">{playback.repeat === 'all' ? '曲順の先頭から繰り返します。' : '次に再生する曲はありません。'}</p>}</div>}
      {sheet === 'lyrics' && selected && <LyricsEditor open embedded onClose={() => setSheet(null)} trackTitle={selected.title} value={lyrics.localSourceText} onSave={async text => { await lyrics.saveText(text); notify('歌詞をこの端末に保存しました。'); }} onImportFile={async file => { await lyrics.importFile(file); notify('歌詞をこの端末に保存しました。'); }} onRemove={lyrics.localAvailable ? async () => { await lyrics.remove(); notify('この端末の歌詞を削除しました。'); } : undefined} error={lyrics.error} busy={lyrics.busy || lyrics.loading} />}
    </div></Sheet>
    <div className={`music-toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">{toast}</div>
  </main>;
}
