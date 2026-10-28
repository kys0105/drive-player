import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const motionPreference = '(prefers-reduced-motion: reduce)';
const expandEasing = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Keep one player mounted, and join its geometry to the actual mini player. */
export function usePlayerMotion(
  open: boolean,
  playerRef: RefObject<HTMLElement | null>,
  miniRef: RefObject<HTMLDivElement | null>,
  miniButtonRef: RefObject<HTMLButtonElement | null>,
) {
  const [present, setPresent] = useState(open);
  const previousOpen = useRef(false);
  const interrupted = useRef<Map<Element, { opacity: string; transform: string; clipPath: string; borderRadius: string }> | null>(null);

  useLayoutEffect(() => {
    const player = playerRef.current;
    const wasOpen = previousOpen.current;
    previousOpen.current = open;
    if (!player) { setPresent(false); return; }
    if (!open && !wasOpen) return;

    setPresent(true);
    const preference = window.matchMedia(motionPreference);
    const animations: Animation[] = [];
    let disposed = false;
    let focusFrame = 0;
    const previousFrame = interrupted.current;
    interrupted.current = null;
    const animatedElements: HTMLElement[] = [player];
    player.dataset.motion = open ? 'opening' : 'closing';

    const focusPlayer = () => {
      if (!disposed && !document.querySelector('dialog[open]') && !player.contains(document.activeElement)) {
        player.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
      }
    };
    if (open) focusFrame = requestAnimationFrame(focusPlayer);

    const finish = () => {
      if (disposed) return;
      player.dataset.motion = open ? 'open' : 'closed';
      setPresent(open);
      // Native menu dialogs have finished dismissing by the end of the reveal.
      focusFrame = requestAnimationFrame(() => {
        if (open) focusPlayer();
        else miniButtonRef.current?.focus({ preventScroll: true });
      });
    };

    if (!preference.matches && typeof player.animate === 'function') {
      const bounds = player.getBoundingClientRect();
      const mini = miniRef.current;
      const origin = mini?.getBoundingClientRect();
      const collapsed = origin && origin.width > 0 && origin.height > 0
        ? `inset(${Math.max(0, origin.top - bounds.top)}px ${Math.max(0, bounds.right - origin.right)}px ${Math.max(0, bounds.bottom - origin.bottom)}px ${Math.max(0, origin.left - bounds.left)}px round 15px)`
        : `inset(${Math.max(0, bounds.height - 110)}px 0px 50px 0px round 15px)`;
      const expanded = 'inset(0px 0px 0px 0px round 0px)';
      const duration = open ? 480 : 340;
      const current = previousFrame?.get(player);
      animations.push(player.animate([
        { clipPath: current?.clipPath ?? (open ? collapsed : expanded), opacity: current?.opacity ?? (open ? 0.6 : 1) },
        { clipPath: open ? expanded : collapsed, opacity: 1, offset: open ? 1 : 0.9 },
        ...open ? [] : [{ clipPath: collapsed, opacity: 0 }],
      ], { duration, easing: expandEasing, fill: 'both' }));

      const cover = player.querySelector<HTMLElement>('.player-cover');
      const thumbnail = mini?.querySelector('img');
      if (cover && thumbnail && !player.classList.contains('lyrics-mode')) {
        const from = thumbnail.getBoundingClientRect();
        const to = cover.getBoundingClientRect();
        if (from.width > 0 && to.width > 0) {
          const scale = from.width / to.width;
          const small = {
            transform: `translate3d(${from.left - to.left}px, ${from.top - to.top}px, 0) scale(${scale})`,
            borderRadius: `${5 / scale}px`,
          };
          const large = { transform: 'translate3d(0, 0, 0) scale(1)', borderRadius: '9px' };
          const currentCover = previousFrame?.get(cover);
          const start = currentCover ? { transform: currentCover.transform, borderRadius: currentCover.borderRadius } : open ? small : large;
          animatedElements.push(cover);
          animations.push(cover.animate([start, open ? large : small],
            { duration, easing: expandEasing, fill: 'both' }));
        }
      }

      for (const element of player.querySelectorAll<HTMLElement>('.player-header, .player-track, .player-controls')) {
        const currentContent = previousFrame?.get(element);
        animatedElements.push(element);
        animations.push(element.animate([
          { opacity: currentContent?.opacity ?? (open ? 0 : 1), transform: currentContent?.transform ?? (open ? 'translate3d(0, 22px, 0)' : 'translate3d(0, 0, 0)') },
          { opacity: open ? 1 : 0, transform: open ? 'translate3d(0, 0, 0)' : 'translate3d(0, 14px, 0)' },
        ], { duration: open ? 300 : 170, delay: open && !previousFrame ? 90 : 0, easing: expandEasing, fill: 'both' }));
      }
    }

    const reduce = () => { if (preference.matches) for (const animation of animations) animation.finish(); };
    preference.addEventListener('change', reduce);
    void Promise.all(animations.map(animation => animation.finished)).then(finish).catch(() => {});
    return () => {
      disposed = true;
      cancelAnimationFrame(focusFrame);
      preference.removeEventListener('change', reduce);
      if (animations.some(animation => animation.playState === 'running')) {
        interrupted.current = new Map(animatedElements.map(element => {
          const style = getComputedStyle(element);
          return [element, { opacity: style.opacity, transform: style.transform, clipPath: style.clipPath, borderRadius: style.borderRadius }];
        }));
      }
      for (const animation of animations) animation.cancel();
    };
  }, [open, playerRef, miniRef, miniButtonRef]);

  return open || present;
}

/** Fade a new library selection in without animating every search keystroke. */
export function useLibraryMotion(ref: RefObject<HTMLDivElement | null>, selection: string) {
  const previous = useRef(selection);
  useLayoutEffect(() => {
    if (previous.current === selection) return;
    previous.current = selection;
    if (window.matchMedia(motionPreference).matches || typeof ref.current?.animate !== 'function') return;
    const animation = ref.current?.animate([
      { opacity: 0, transform: 'translate3d(0, 7px, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ], { duration: 220, easing: expandEasing });
    return () => animation?.cancel();
  }, [ref, selection]);
}
