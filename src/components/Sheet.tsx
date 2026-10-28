import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import './Sheet.css';

type Content = { title: string; children: ReactNode; key: number };
type Frame = { current: Content; previous: Content | null };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function Sheet({ open, title, onClose, children }: PropsWithChildren<{ open: boolean; title: string; onClose: () => void }>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [frame, setFrame] = useState<Frame>({ current: { title, children, key: 0 }, previous: null });

  // Keep the last page intact while its parent clears the selected sheet.
  useLayoutEffect(() => {
    if (!open) return;
    const crossfade = Boolean(ref.current?.open) && !reducedMotion();
    setFrame(previous => {
      if (previous.current.title === title && previous.current.children === children) return previous;
      const changedPage = previous.current.title !== title;
      return {
        current: { title, children, key: previous.current.key + Number(changedPage) },
        previous: changedPage && crossfade ? previous.current : previous.previous,
      };
    });
  }, [open, title, children]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    let animationFrame = 0;
    let closeTimer = 0;
    if (open) {
      if (!dialog.open) {
        dialog.dataset.visible = 'false';
        dialog.showModal();
        // Commit the resting position before asking the browser to transition.
        dialog.getBoundingClientRect();
      }
      if (reducedMotion()) dialog.dataset.visible = 'true';
      else animationFrame = requestAnimationFrame(() => { dialog.dataset.visible = 'true'; });
    } else if (dialog.open) {
      dialog.dataset.visible = 'false';
      const finish = () => {
        dialog.close();
        setFrame(previous => ({ current: { ...previous.current, children: null }, previous: null }));
      };
      if (reducedMotion()) finish();
      else closeTimer = window.setTimeout(finish, 260);
    }
    return () => { cancelAnimationFrame(animationFrame); clearTimeout(closeTimer); };
  }, [open]);

  useLayoutEffect(() => {
    if (open && ref.current?.open) {
      ref.current.querySelector<HTMLButtonElement>('.sheet-page:not(.sheet-page--leaving) .sheet-header button')?.focus({ preventScroll: true });
    }
  }, [open, frame.current.key]);

  const previousKey = frame.previous?.key;
  useEffect(() => {
    if (previousKey === undefined) return;
    const timer = window.setTimeout(() => {
      setFrame(previous => previous.previous?.key === previousKey ? { ...previous, previous: null } : previous);
    }, 200);
    return () => clearTimeout(timer);
  }, [previousKey]);

  useEffect(() => {
    const dialog = ref.current;
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  function page(content: Content, leaving = false) {
    return <div key={content.key} className={`sheet-page ${leaving ? 'sheet-page--leaving' : frame.previous ? 'sheet-page--entering' : ''}`} aria-hidden={leaving || undefined} inert={leaving || !open || undefined}>
      <div className="sheet-surface">
        <header className="sheet-header"><h2 id={leaving ? undefined : titleId}>{content.title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="閉じる"><Icon name="close" /></button></header>
        <div className="sheet-content">{content.children}</div>
      </div>
    </div>;
  }

  return createPortal(<dialog ref={ref} className="sheet-dialog" data-motion="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (open) onClose(); }}
    onClick={event => { if (open && event.target === event.currentTarget) onClose(); }}>
    {frame.previous && page(frame.previous, true)}
    {page(frame.current)}
  </dialog>, document.body);
}
