import { useEffect, useRef } from 'react';
import type { PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export default function Sheet({ open, title, onClose, children }: PropsWithChildren<{ open: boolean; title: string; onClose: () => void }>) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (open && !dialog?.open) dialog?.showModal(); if (!open && dialog?.open) dialog.close(); }, [open]);
  return createPortal(<dialog ref={ref} className="sheet-dialog" aria-labelledby="sheet-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="sheet-surface"><header className="sheet-header"><h2 id="sheet-title">{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="閉じる"><Icon name="close" /></button></header><div className="sheet-content">{children}</div></div></dialog>, document.body);
}
