import { useId, useRef, useState } from 'react';
import { MAX_LYRIC_CHARACTERS } from './parse.ts';
import './lyrics.css';

export type LyricsEditorProps = {
  open: boolean;
  embedded?: boolean;
  onClose: () => void;
  trackTitle: string;
  value: string;
  onSave: (text: string) => Promise<void>;
  onImportFile: (file: File) => Promise<void>;
  onRemove?: () => Promise<void>;
  error?: string | null;
  busy?: boolean;
};

function EditorContent({ onClose, trackTitle, value, onSave, onImportFile, onRemove, error, busy, embedded = false }: LyricsEditorProps) {
  const [draft, setDraft] = useState(value);
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaId = useId();
  const noteId = useId();
  const disabled = Boolean(busy || working);

  async function perform(action: () => Promise<void>) {
    if (disabled) return;
    setLocalError(null);
    setWorking(true);
    try {
      await action();
      onClose();
    } catch (cause: unknown) {
      setLocalError(cause instanceof Error ? cause.message : '歌詞を処理できませんでした。');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="lyrics-editor">
      <div className="lyrics-editor-heading">
        <div>{!embedded && <h2>歌詞を追加・編集</h2>}<p>{trackTitle}</p></div>
        {!embedded && <button type="button" className="lyrics-editor-close" onClick={onClose} disabled={disabled}>閉じる</button>}
      </div>
      <p id={noteId} className="lyrics-editor-note">UTF-8のTXT・LRCに対応しています。時刻付きLRCは再生に追従し、通常のテキストはそのまま表示します。この端末だけに保存されます。</p>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.lrc,text/plain"
        hidden
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void perform(() => onImportFile(file));
        }}
      />
      <button type="button" className="lyrics-editor-file" disabled={disabled} onClick={() => inputRef.current?.click()}>TXT・LRCファイルを選ぶ</button>
      <label className="lyrics-editor-label" htmlFor={textareaId}>歌詞を貼り付け</label>
      <textarea
        id={textareaId}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setLocalError(null); }}
        placeholder="歌詞を貼り付けてください"
        maxLength={MAX_LYRIC_CHARACTERS}
        spellCheck={false}
        disabled={disabled}
        aria-describedby={noteId}
        className="lyrics-editor-text"
      />
      {(localError || error) && <p className="lyrics-editor-error" role="alert">{localError || error}</p>}
      <div className="lyrics-editor-actions">
        {onRemove && value.trim() && <button type="button" className="lyrics-editor-remove" disabled={disabled} onClick={() => { void perform(onRemove); }}>歌詞を削除</button>}
        <button type="button" className="lyrics-editor-save" disabled={disabled || !draft.trim()} onClick={() => { void perform(() => onSave(draft)); }}>{disabled ? '保存中…' : '歌詞を保存'}</button>
      </div>
    </div>
  );
}

/** Content for the app's own sheet; no portal or nested modal is introduced. */
export default function LyricsEditor(props: LyricsEditorProps) {
  if (!props.open) return null;
  return <EditorContent key={props.trackTitle + '\u0000' + props.value} {...props} />;
}
