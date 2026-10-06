/**
 * API 키 저장소. 대화 저장소와 분리한다.
 *
 * - '이 기기에 저장': 확장 프로그램 origin의 별도 IndexedDB에 AES-GCM으로 암호화해 둔다.
 *   암호화 키는 내보낼 수 없는(non-extractable) CryptoKey로 같은 DB에 있다.
 *   디스크에 평문으로 남지 않게 하는 정도의 보호이며, 이 브라우저 프로필 자체를 지키지는 못한다.
 * - '브라우저를 닫을 때까지만': chrome.storage.session(메모리, 확장 프로그램 페이지 전용)에 둔다.
 *
 * 키는 content script·페이지 DOM·로그로 보내지 않는다. 화면에는 끝 4자리만 보여 준다.
 */
import type { ProviderId } from '../shared/conversation';
import { openDatabase, promisify, txDone } from './idb';

export type KeyPersistence = 'device' | 'session';

export interface KeyStatus {
  present: boolean;
  persistence?: KeyPersistence;
  /** 끝 4자리 */
  hint?: string;
  savedAt?: number;
}

interface StoredKey {
  provider: ProviderId;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
  hint: string;
  savedAt: number;
}

const DB_NAME = 'noodlelens-secrets';
const SESSION_PREFIX = 'nl.key.';

interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const memorySession = new Map<string, unknown>();
const fallbackSession: SessionArea = {
  async get(key) {
    return memorySession.has(key) ? { [key]: memorySession.get(key) } : {};
  },
  async set(items) {
    for (const [key, value] of Object.entries(items)) memorySession.set(key, value);
  },
  async remove(key) {
    memorySession.delete(key);
  },
};

function sessionArea(): SessionArea {
  return typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : fallbackSession;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb() {
  dbPromise ??= openDatabase(DB_NAME, 1, (db) => {
    if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'provider' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

export async function closeSecretsForTest() {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  memorySession.clear();
}

async function wrappingKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = (await promisify(db.transaction('meta').objectStore('meta').get('aes'))) as CryptoKey | undefined;
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(key, 'aes');
  await txDone(tx);
  return key;
}

function hintOf(apiKey: string): string {
  return apiKey.slice(-4);
}

export function normalizeKey(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, '');
}

export async function saveApiKey(provider: ProviderId, rawKey: string, persistence: KeyPersistence): Promise<void> {
  const apiKey = normalizeKey(rawKey);
  if (!apiKey) throw new Error('빈 키는 저장할 수 없습니다.');
  const db = await getDb();
  if (persistence === 'session') {
    await sessionArea().set({ [SESSION_PREFIX + provider]: { apiKey, savedAt: Date.now() } });
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').delete(provider);
    await txDone(tx);
    return;
  }
  const key = await wrappingKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(apiKey));
  const record: StoredKey = { provider, iv, data, hint: hintOf(apiKey), savedAt: Date.now() };
  const tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').put(record);
  await txDone(tx);
  await sessionArea().remove(SESSION_PREFIX + provider);
}

export async function loadApiKey(provider: ProviderId): Promise<string | null> {
  const session = (await sessionArea().get(SESSION_PREFIX + provider))[SESSION_PREFIX + provider] as
    | { apiKey?: string }
    | undefined;
  if (session?.apiKey) return session.apiKey;
  const db = await getDb();
  const record = (await promisify(db.transaction('keys').objectStore('keys').get(provider))) as StoredKey | undefined;
  if (!record) return null;
  const key = await wrappingKey(db);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.data);
  return new TextDecoder().decode(plain);
}

export async function getKeyStatus(provider: ProviderId): Promise<KeyStatus> {
  const session = (await sessionArea().get(SESSION_PREFIX + provider))[SESSION_PREFIX + provider] as
    | { apiKey?: string; savedAt?: number }
    | undefined;
  if (session?.apiKey) {
    return { present: true, persistence: 'session', hint: hintOf(session.apiKey), savedAt: session.savedAt };
  }
  const db = await getDb();
  const record = (await promisify(db.transaction('keys').objectStore('keys').get(provider))) as StoredKey | undefined;
  if (!record) return { present: false };
  return { present: true, persistence: 'device', hint: record.hint, savedAt: record.savedAt };
}

export async function deleteApiKey(provider: ProviderId): Promise<void> {
  await sessionArea().remove(SESSION_PREFIX + provider);
  const db = await getDb();
  const tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').delete(provider);
  await txDone(tx);
}
