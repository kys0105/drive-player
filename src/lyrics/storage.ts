import { parseLyrics, type ParsedLyrics } from './parse.ts';
import type { LyricsAsset } from '../types.ts';

export type LyricsIdentity = { scope: string; trackId: string; version: string };
export type StoredLyrics = LyricsIdentity & { text: string; updatedAt: number; lyrics: ParsedLyrics };
export type DriveLyricsIdentity = Pick<LyricsIdentity, 'scope' | 'trackId'>;
export type StoredDriveLyrics = DriveLyricsIdentity & { asset: LyricsAsset; text: string; updatedAt: number; lyrics: ParsedLyrics };
type DriveRecordData = DriveLyricsIdentity & { key: string; source: 'drive'; asset: LyricsAsset; text: string; updatedAt: number };
type RecordData = LyricsIdentity & { key: string; text: string; updatedAt: number };
type Epoch = { all: number; scope: number; record: number };
type ClearListener = (scope?: string) => void;

const DB_NAME = 'drive-player-lyrics-v1';
const STORE_NAME = 'lyrics';
let database: Promise<IDBDatabase> | null = null;
let allEpoch = 0;
let pendingAll = 0;
const scopeEpochs = new Map<string, number>();
const recordEpochs = new Map<string, number>();
const pendingScopes = new Map<string, number>();
const listeners = new Set<ClearListener>();
let channel: BroadcastChannel | null = null;

export function lyricsIdentityKey(identity: LyricsIdentity): string {
  if (
    typeof identity.scope !== 'string' || typeof identity.trackId !== 'string' || !identity.scope || !identity.trackId ||
    identity.scope.length > 1_024 || identity.trackId.length > 1_024 ||
    typeof identity.version !== 'string' || identity.version.length > 2_048
  ) throw new Error('歌詞を保存する曲の情報を確認してください。');
  return JSON.stringify([identity.scope, identity.trackId, identity.version]);
}

function epochFor(identity: LyricsIdentity): Epoch {
  return { all: allEpoch, scope: scopeEpochs.get(identity.scope) ?? 0, record: recordEpochs.get(lyricsIdentityKey(identity)) ?? 0 };
}

function isCurrent(identity: LyricsIdentity, epoch: Epoch) {
  const now = epochFor(identity);
  return !pendingAll && !(pendingScopes.get(identity.scope) ?? 0) &&
    now.all === epoch.all && now.scope === epoch.scope && now.record === epoch.record;
}

function expiredOperation() {
  return new Error('ログイン状態が変更されたため、歌詞を保存できませんでした。');
}

/** Capture before starting network/file reads so a completed logout cannot be undone by a late write. */
export function createLyricsScopeGuard(scope: string): () => boolean {
  lyricsIdentityKey({ scope, trackId: 'guard', version: '' });
  const all = allEpoch;
  const scoped = scopeEpochs.get(scope) ?? 0;
  return () => !pendingAll && !(pendingScopes.get(scope) ?? 0) && all === allEpoch && scoped === (scopeEpochs.get(scope) ?? 0);
}

function announceClear(scope?: string) {
  for (const listener of listeners) {
    try { listener(scope); } catch { /* One subscriber must not prevent clearing the rest. */ }
  }
}

function ensureChannel() {
  if (channel || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel('drive-player-lyrics-clear');
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'clear') return;
      const scope = 'scope' in value ? value.scope : undefined;
      if (scope !== undefined && typeof scope !== 'string') return;
      void clearData(scope, false).catch(() => { /* The caller tab also clears the shared database. */ });
    };
  } catch { channel = null; }
}

export function subscribeLyricsCleared(listener: ClearListener): () => void {
  listeners.add(listener);
  ensureChannel();
  return () => { listeners.delete(listener); };
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('このブラウザでは歌詞を端末に保存できません。');
  if (!database) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('scope', 'scope');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          if (database === opening) database = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(new Error('歌詞の保存領域を開けませんでした。'));
      request.onblocked = () => reject(new Error('ほかのタブを閉じてから、もう一度お試しください。'));
    });
    database = opening;
    void opening.catch(() => { if (database === opening) database = null; });
  }
  return database;
}

function requestResult<T>(db: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    let result!: T;
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(new Error('歌詞の保存処理を完了できませんでした。端末の空き容量を確認してください。'));
    transaction.onerror = () => { /* onabort returns the error once. */ };
  });
}

function decodeRecord(value: unknown, identity: LyricsIdentity): StoredLyrics | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<RecordData>;
  if (record.scope !== identity.scope || record.trackId !== identity.trackId || record.version !== identity.version ||
      record.key !== lyricsIdentityKey(identity) || typeof record.text !== 'string' ||
      typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return null;
  try {
    const lyrics = parseLyrics(record.text);
    if (!lyrics.lines.length) return null;
    return { ...identity, text: record.text, updatedAt: record.updatedAt, lyrics };
  } catch { return null; }
}

export async function getStoredLyrics(identity: LyricsIdentity): Promise<StoredLyrics | null> {
  const key = lyricsIdentityKey(identity);
  const epoch = epochFor(identity);
  const db = await openDatabase();
  if (!isCurrent(identity, epoch)) return null;
  const result: unknown = await requestResult(db, 'readonly', (store) => store.get(key));
  return isCurrent(identity, epoch) ? decodeRecord(result, identity) : null;
}

export async function saveStoredLyrics(identity: LyricsIdentity, text: string): Promise<StoredLyrics> {
  const key = lyricsIdentityKey(identity);
  const lyrics = parseLyrics(text);
  if (!lyrics.lines.length) throw new Error('保存する歌詞を入力してください。');
  const epoch = epochFor(identity);
  if (!isCurrent(identity, epoch)) throw expiredOperation();
  const db = await openDatabase();
  if (!isCurrent(identity, epoch)) throw expiredOperation();
  const updatedAt = Date.now();
  await requestResult(db, 'readwrite', (store) => store.put({ ...identity, key, text, updatedAt } satisfies RecordData));
  if (!isCurrent(identity, epoch)) throw expiredOperation();
  return { ...identity, text, updatedAt, lyrics };
}

export async function removeStoredLyrics(identity: LyricsIdentity): Promise<void> {
  const key = lyricsIdentityKey(identity);
  recordEpochs.set(key, (recordEpochs.get(key) ?? 0) + 1);
  const db = await openDatabase();
  await requestResult(db, 'readwrite', (store) => store.delete(key));
}

function driveKey(identity: DriveLyricsIdentity) {
  lyricsIdentityKey({ ...identity, version: '' });
  // The four-part key cannot collide with the legacy three-part local key.
  return JSON.stringify(['drive', identity.scope, identity.trackId, 'lyrics']);
}

export function validLyricsAsset(value: unknown): value is LyricsAsset {
  if (!value || typeof value !== 'object') return false;
  const asset = value as Partial<LyricsAsset>;
  return typeof asset.id === 'string' && asset.id.length > 0 && asset.id.length <= 1_024 &&
    typeof asset.ver === 'string' && asset.ver.length <= 2_048 && (asset.format === 'lrc' || asset.format === 'txt');
}

export async function getStoredDriveLyrics(identity: DriveLyricsIdentity, expectedAsset?: LyricsAsset): Promise<StoredDriveLyrics | null> {
  const key = driveKey(identity);
  const allowed = createLyricsScopeGuard(identity.scope);
  const revision = recordEpochs.get(key) ?? 0;
  const db = await openDatabase();
  if (!allowed()) return null;
  const value: unknown = await requestResult(db, 'readonly', (store) => store.get(key));
  if (!allowed() || revision !== (recordEpochs.get(key) ?? 0) || !value || typeof value !== 'object') return null;
  const record = value as Partial<DriveRecordData>;
  if (record.key !== key || record.source !== 'drive' || record.scope !== identity.scope || record.trackId !== identity.trackId ||
      !validLyricsAsset(record.asset) || typeof record.text !== 'string' || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return null;
  if (expectedAsset && (record.asset.id !== expectedAsset.id || record.asset.ver !== expectedAsset.ver || record.asset.format !== expectedAsset.format)) return null;
  try {
    const lyrics = parseLyrics(record.text);
    return lyrics.lines.length ? { ...identity, asset: record.asset, text: record.text, updatedAt: record.updatedAt, lyrics } : null;
  } catch { return null; }
}

export async function saveStoredDriveLyrics(identity: DriveLyricsIdentity, asset: LyricsAsset, text: string, stillAllowed: () => boolean = () => true): Promise<StoredDriveLyrics> {
  const key = driveKey(identity);
  if (!validLyricsAsset(asset)) throw new Error('Driveの歌詞情報を確認してください。');
  const lyrics = parseLyrics(text);
  if (!lyrics.lines.length) throw new Error('Driveの歌詞ファイルに本文がありません。');
  const scopeAllowed = createLyricsScopeGuard(identity.scope);
  const revision = recordEpochs.get(key) ?? 0;
  const allowed = () => stillAllowed() && scopeAllowed() && revision === (recordEpochs.get(key) ?? 0);
  if (!allowed()) throw expiredOperation();
  const db = await openDatabase();
  if (!allowed()) throw expiredOperation();
  const updatedAt = Date.now();
  await requestResult(db, 'readwrite', store => store.put({ ...identity, key, source: 'drive', asset, text, updatedAt } satisfies DriveRecordData));
  if (!allowed()) throw expiredOperation();
  return { ...identity, asset, text, updatedAt, lyrics };
}

export async function removeStoredDriveLyrics(identity: DriveLyricsIdentity, stillAllowed: () => boolean = () => true): Promise<void> {
  const key = driveKey(identity);
  const allowed = createLyricsScopeGuard(identity.scope);
  if (!allowed() || !stillAllowed()) throw expiredOperation();
  recordEpochs.set(key, (recordEpochs.get(key) ?? 0) + 1);
  const db = await openDatabase();
  if (!allowed() || !stillAllowed()) throw expiredOperation();
  await requestResult(db, 'readwrite', store => store.delete(key));
}

async function clearData(scope: string | undefined, broadcast: boolean): Promise<void> {
  if (scope === undefined) {
    allEpoch++;
    pendingAll++;
    scopeEpochs.clear();
    recordEpochs.clear();
  } else {
    scopeEpochs.set(scope, (scopeEpochs.get(scope) ?? 0) + 1);
    pendingScopes.set(scope, (pendingScopes.get(scope) ?? 0) + 1);
  }
  announceClear(scope);
  try {
    if (typeof indexedDB !== 'undefined') {
      const db = await openDatabase();
      if (scope === undefined) {
        await requestResult(db, 'readwrite', (store) => store.clear());
      } else {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, 'readwrite');
          const store = transaction.objectStore(STORE_NAME);
          const cursor = store.index('scope').openKeyCursor(IDBKeyRange.only(scope));
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (current) { store.delete(current.primaryKey); current.continue(); }
          };
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(new Error('この端末の歌詞を削除できませんでした。'));
          transaction.onerror = () => { /* onabort returns the error once. */ };
        });
      }
    }
    if (broadcast) {
      ensureChannel();
      channel?.postMessage({ type: 'clear', scope });
    }
  } finally {
    if (scope === undefined) pendingAll = Math.max(0, pendingAll - 1);
    else {
      const remaining = (pendingScopes.get(scope) ?? 1) - 1;
      if (remaining > 0) pendingScopes.set(scope, remaining);
      else pendingScopes.delete(scope);
    }
  }
}

export async function clearStoredLyrics(scope?: string): Promise<void> {
  await clearData(scope, true);
}
