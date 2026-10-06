/**
 * 대화·메시지·스냅샷 저장소 (확장 프로그램 origin의 IndexedDB).
 *
 * content script는 페이지 origin의 저장소를 쓰므로 이 데이터에 접근할 수 없다.
 * 대화를 지우면 그 대화의 메시지와 스냅샷(원문 수집 자료)도 한 트랜잭션에서 함께 지운다.
 */
import type { AssistantMessage, Conversation, Message } from '../shared/conversation';
import { sortMessages } from '../shared/conversation';
import type { StoredSnapshot } from '../shared/snapshot';
import { openDatabase, promisify, txDone } from './idb';

const DB_NAME = 'noodlelens';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  dbPromise ??= openDatabase(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains('conversations')) {
      db.createObjectStore('conversations', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
    }
    if (!db.objectStoreNames.contains('messages')) {
      db.createObjectStore('messages', { keyPath: 'id' }).createIndex('conversationId', 'conversationId');
    }
    if (!db.objectStoreNames.contains('snapshots')) {
      db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('conversationId', 'conversationId');
    }
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/** 테스트용: 열린 연결을 닫고 다음 호출에서 다시 연다 */
export async function closeDbForTest() {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

export async function listConversations(): Promise<Conversation[]> {
  const db = await getDb();
  const all = await promisify(db.transaction('conversations').objectStore('conversations').getAll());
  return (all as Conversation[]).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const db = await getDb();
  return (await promisify(db.transaction('conversations').objectStore('conversations').get(id))) as Conversation | undefined;
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('conversations', 'readwrite');
  tx.objectStore('conversations').put(conversation);
  await txDone(tx);
}

export async function listMessages(conversationId: string): Promise<Message[]> {
  const db = await getDb();
  const index = db.transaction('messages').objectStore('messages').index('conversationId');
  return sortMessages((await promisify(index.getAll(conversationId))) as Message[]);
}

export async function saveMessage(message: Message): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('messages', 'readwrite');
  tx.objectStore('messages').put(message);
  await txDone(tx);
}

/** 질문·답변 자리·스냅샷·대화 갱신을 한 번에 저장한다 */
export async function saveTurn(input: {
  conversation: Conversation;
  messages: Message[];
  snapshot?: StoredSnapshot;
}): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['conversations', 'messages', 'snapshots'], 'readwrite');
  tx.objectStore('conversations').put(input.conversation);
  for (const message of input.messages) tx.objectStore('messages').put(message);
  if (input.snapshot) tx.objectStore('snapshots').put(input.snapshot);
  await txDone(tx);
}

export async function listSnapshots(conversationId: string): Promise<StoredSnapshot[]> {
  const db = await getDb();
  const index = db.transaction('snapshots').objectStore('snapshots').index('conversationId');
  return (await promisify(index.getAll(conversationId))) as StoredSnapshot[];
}

async function deleteByIndex(store: IDBObjectStore, conversationId: string) {
  const keys = await promisify(store.index('conversationId').getAllKeys(conversationId));
  for (const key of keys) store.delete(key);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['conversations', 'messages', 'snapshots'], 'readwrite');
  tx.objectStore('conversations').delete(id);
  await deleteByIndex(tx.objectStore('messages'), id);
  await deleteByIndex(tx.objectStore('snapshots'), id);
  await txDone(tx);
}

export async function deleteAllConversations(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['conversations', 'messages', 'snapshots'], 'readwrite');
  tx.objectStore('conversations').clear();
  tx.objectStore('messages').clear();
  tx.objectStore('snapshots').clear();
  await txDone(tx);
}

/** 생성 중(pending/streaming)으로 저장된 답변. 패널이 닫혀 끊긴 요청을 찾는 데 쓴다 */
export async function listActiveAssistantMessages(): Promise<AssistantMessage[]> {
  const db = await getDb();
  const all = (await promisify(db.transaction('messages').objectStore('messages').getAll())) as Message[];
  return all.filter(
    (m): m is AssistantMessage => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming'),
  );
}

export async function countStored(): Promise<{ conversations: number; messages: number; snapshots: number }> {
  const db = await getDb();
  const tx = db.transaction(['conversations', 'messages', 'snapshots']);
  const [conversations, messages, snapshots] = await Promise.all([
    promisify(tx.objectStore('conversations').count()),
    promisify(tx.objectStore('messages').count()),
    promisify(tx.objectStore('snapshots').count()),
  ]);
  return { conversations, messages, snapshots };
}
