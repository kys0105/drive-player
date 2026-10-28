import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, PointerEvent } from 'react';
import { formatTime } from './music';
import './SeekBar.css';

type Props = {
  trackKey: string;
  position: number;
  duration: number;
  active: boolean;
  loading?: boolean;
  onSeek: (seconds: number) => void;
};

type Gesture = {
  id: number;
  trackKey: string;
  duration: number;
  startPosition: number;
  startX: number;
  left: number;
  width: number;
  relative: boolean;
  moved: boolean;
  target: HTMLInputElement;
};

type Preview = { trackKey: string; duration: number; value: number };
const touchSlop = 4;
const clamp = (value: number, duration: number) => Math.max(0, Math.min(duration, Number.isFinite(value) ? value : 0));

function releaseCapture(gesture: Gesture | null) {
  if (!gesture) return;
  try {
    if (gesture.target.hasPointerCapture(gesture.id)) gesture.target.releasePointerCapture(gesture.id);
  } catch { /* The browser may have already cancelled or detached this pointer. */ }
}

function positionAt(gesture: Gesture, clientX: number) {
  return clamp(gesture.relative
    ? gesture.startPosition + (clientX - gesture.startX) / gesture.width * gesture.duration
    : (clientX - gesture.left) / gesture.width * gesture.duration, gesture.duration);
}

function spokenTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}分${value % 60}秒`;
}

export default function SeekBar({ trackKey, position, duration, active, loading = false, onSeek }: Props) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const available = active && Boolean(trackKey) && total > 0;
  const [preview, setPreview] = useState<Preview | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ trackKey, total, available, position, onSeek });
  latest.current = { trackKey, total, available, position, onSeek };
  const scrubbing = available && preview?.trackKey === trackKey && preview.duration === total;
  const value = clamp(scrubbing ? preview.value : position, total);

  const cancel = useCallback(() => {
    const previous = gesture.current;
    gesture.current = null;
    setPreview(null);
    releaseCapture(previous);
  }, []);

  useEffect(() => { cancel(); }, [active, trackKey, total, cancel]);

  useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'hidden') cancel(); };
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', visibility);
      const previous = gesture.current;
      gesture.current = null;
      releaseCapture(previous);
    };
  }, [cancel]);

  function start(event: PointerEvent<HTMLInputElement>) {
    if (!available || gesture.current || !event.isPrimary || event.button !== 0) return;
    // Own pointer gestures; the native range remains for keyboard and assistive input.
    event.preventDefault();
    const target = event.currentTarget;
    const bounds = target.getBoundingClientRect();
    if (!bounds.width) return;
    const next: Gesture = {
      id: event.pointerId, trackKey, duration: total,
      startPosition: clamp(position, total), startX: event.clientX,
      left: bounds.left, width: bounds.width,
      relative: event.pointerType !== 'mouse', moved: false, target,
    };
    gesture.current = next;
    target.focus({ preventScroll: true });
    try { target.setPointerCapture(event.pointerId); }
    catch { cancel(); return; }
    setPreview({ trackKey, duration: total, value: positionAt(next, event.clientX) });
  }

  function move(event: PointerEvent<HTMLInputElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    event.preventDefault();
    const live = latest.current;
    if (!live.available || live.trackKey !== current.trackKey || live.total !== current.duration) { cancel(); return; }
    if (Math.abs(event.clientX - current.startX) > touchSlop) current.moved = true;
    if (current.relative && !current.moved) return;
    setPreview({ trackKey: current.trackKey, duration: current.duration, value: positionAt(current, event.clientX) });
  }

  function finish(event: PointerEvent<HTMLInputElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    event.preventDefault();
    const live = latest.current;
    const moved = current.moved || Math.abs(event.clientX - current.startX) > touchSlop;
    const commit = live.available && live.trackKey === current.trackKey && live.total === current.duration && (!current.relative || moved);
    const next = positionAt(current, event.clientX);
    // Clear first: releasing capture also emits lostpointercapture.
    gesture.current = null;
    setPreview(null);
    releaseCapture(current);
    if (commit) live.onSeek(next);
  }

  function nativeChange(event: ChangeEvent<HTMLInputElement>) {
    if (!available || gesture.current) return;
    onSeek(clamp(Number(event.currentTarget.value), total));
  }

  function cancelPointer(event: PointerEvent<HTMLInputElement>) {
    if (gesture.current?.id === event.pointerId) cancel();
  }

  return <div className="seek-bar" data-scrubbing={scrubbing} data-disabled={!available}
    onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}>
    <div className="seek-bar__interaction">
      <input className="seek-bar__input" type="range" aria-label="再生位置"
        aria-valuetext={total > 0 ? `${spokenTime(value)}、残り${spokenTime(total - value)}` : '再生時間を読み込み中'}
        min={0} max={total || 1} step={1} value={value} disabled={!available}
        onPointerDown={start} onPointerMove={move} onPointerUp={finish}
        onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer} onBlur={cancel}
        onClick={event => event.preventDefault()} onChange={nativeChange} />
      <div className="seek-bar__track" aria-hidden="true">
        <div className="seek-bar__fill" style={{ width: `${total ? value / total * 100 : 0}%` }} />
      </div>
    </div>
    <div className="seek-bar__times" aria-hidden="true">
      <span>{formatTime(value)}</span>
      <span>{total ? `−${formatTime(total - value)}` : loading ? '読み込み中…' : '--:--'}</span>
    </div>
  </div>;
}
