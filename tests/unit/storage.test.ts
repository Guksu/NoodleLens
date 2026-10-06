import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Conversation, UserMessage } from '../../src/shared/conversation';
import * as db from '../../src/storage/db';
import { closeSecretsForTest, deleteApiKey, getKeyStatus, loadApiKey, saveApiKey } from '../../src/storage/secrets';
import { buildTurns } from '../../src/providers/prompt';
import { el, snapshot, stored } from './fixtures';

function conversation(id: string, updatedAt = 1): Conversation {
  return { id, title: id, provider: 'anthropic', model: 'm', createdAt: 1, updatedAt, maxElementNumber: 2 };
}

function user(id: string, conversationId: string, createdAt: number, snapshotId?: string): UserMessage {
  return { id, conversationId, role: 'user', text: `질문 ${id}`, createdAt, ...(snapshotId ? { snapshotId } : {}) };
}

function assistant(id: string, conversationId: string, createdAt: number, status: AssistantMessage['status'], text = `답 ${id}`): AssistantMessage {
  return { id, conversationId, role: 'assistant', replyTo: '', provider: 'anthropic', model: 'm', text, status, createdAt, updatedAt: createdAt };
}

afterEach(async () => {
  await db.deleteAllConversations();
});

describe('대화 저장소', () => {
  it('질문·답변·스냅샷을 함께 저장하고 시간순으로 읽는다', async () => {
    const snap = stored(snapshot([el({ id: 'E1', role: 'target' })]), 'c1');
    await db.saveTurn({ conversation: conversation('c1'), messages: [assistant('m2', 'c1', 2, 'pending'), user('m1', 'c1', 1, snap.id)], snapshot: snap });
    const messages = await db.listMessages('c1');
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect((await db.listSnapshots('c1')).map((s) => s.id)).toEqual([snap.id]);
  });

  it('대화를 지우면 그 대화의 메시지와 스냅샷도 지우고 다른 대화는 남긴다', async () => {
    await db.saveTurn({ conversation: conversation('c1'), messages: [user('a', 'c1', 1)], snapshot: { ...stored(snapshot([el({ id: 'E1', role: 'target' })]), 'c1'), id: 's-a' } });
    await db.saveTurn({ conversation: conversation('c2'), messages: [user('b', 'c2', 1)], snapshot: { ...stored(snapshot([el({ id: 'E1', role: 'target' })]), 'c2'), id: 's-b' } });
    await db.deleteConversation('c1');
    expect(await db.getConversation('c1')).toBeUndefined();
    expect(await db.listMessages('c1')).toEqual([]);
    expect(await db.listSnapshots('c1')).toEqual([]);
    expect(await db.countStored()).toEqual({ conversations: 1, messages: 1, snapshots: 1 });
  });

  it('생성 중으로 남은 답변을 찾는다(패널이 닫혀 끊긴 요청 정리용)', async () => {
    await db.saveTurn({
      conversation: conversation('c1'),
      messages: [assistant('x', 'c1', 1, 'streaming'), assistant('y', 'c1', 2, 'complete'), assistant('z', 'c1', 3, 'pending')],
    });
    expect((await db.listActiveAssistantMessages()).map((m) => m.id).sort()).toEqual(['x', 'z']);
  });

  it('대화 목록은 최근 갱신 순이다', async () => {
    await db.saveConversation(conversation('old', 1));
    await db.saveConversation(conversation('new', 5));
    expect((await db.listConversations()).map((c) => c.id)).toEqual(['new', 'old']);
  });
});

describe('API 키 저장소', () => {
  afterEach(async () => {
    await deleteApiKey('anthropic');
    await deleteApiKey('openai');
    await closeSecretsForTest();
  });

  it('이 기기 저장은 암호화해 두고 끝 4자리만 상태로 보여 준다', async () => {
    await saveApiKey('anthropic', '  sk-ant-api03-LOCALTESTKEY1234  ', 'device');
    expect(await loadApiKey('anthropic')).toBe('sk-ant-api03-LOCALTESTKEY1234');
    expect(await getKeyStatus('anthropic')).toMatchObject({ present: true, persistence: 'device', hint: '1234' });
  });

  it('세션 저장으로 바꾸면 기기 저장본을 지운다', async () => {
    await saveApiKey('openai', 'sk-device-0000', 'device');
    await saveApiKey('openai', 'sk-session-9999', 'session');
    expect(await getKeyStatus('openai')).toMatchObject({ present: true, persistence: 'session', hint: '9999' });
    await closeSecretsForTest(); // 세션(메모리) 저장본이 사라진 상황
    expect(await loadApiKey('openai')).toBeNull();
  });

  it('삭제하면 키가 남지 않는다', async () => {
    await saveApiKey('anthropic', 'sk-ant-x', 'device');
    await deleteApiKey('anthropic');
    expect(await getKeyStatus('anthropic')).toEqual({ present: false });
  });
});

describe('대화 이력 → 요청 변환', () => {
  it('완료된 답변만 넣고, 같은 역할이 이어지면 합치고, 대상 질문 뒤는 자른다', () => {
    const snap = stored(snapshot([el({ id: 'E1', role: 'target' })]), 'c1');
    const messages = [
      user('u1', 'c1', 1, snap.id),
      assistant('a1', 'c1', 2, 'interrupted', '끊긴 부분'),
      user('u2', 'c1', 3),
      assistant('a2', 'c1', 4, 'complete', '좋은 답'),
      user('u3', 'c1', 5),
      assistant('a3', 'c1', 6, 'pending', ''),
      user('u4', 'c1', 7),
    ];
    const turns = buildTurns(messages, new Map([[snap.id, snap]]), 'u3');
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(turns[0]!.text).toContain('<page_snapshot');
    expect(turns[0]!.text).toContain('질문 u2');
    expect(turns[0]!.text).not.toContain('끊긴 부분');
    expect(turns[2]!.text).toBe('질문: 질문 u3');
  });
});
