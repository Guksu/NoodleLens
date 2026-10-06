import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Conversation, Message } from '../../src/shared/conversation';
import { RequestManager, type RequestDeps } from '../../src/panel/requests';
import { NEW_KEY, Store, initialState, type PanelState } from '../../src/panel/store';
import type { ChatProvider, ChatRequest, StreamEvent } from '../../src/providers/types';
import { DEFAULT_SETTINGS } from '../../src/storage/settings';
import { el, snapshot, stored } from './fixtures';

/** 테스트가 이벤트를 하나씩 밀어 넣는 제공자 */
class ControlledProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  requests: ChatRequest[] = [];
  private queue: Array<StreamEvent | 'end'> = [];
  private wake: (() => void) | null = null;

  push(...events: Array<StreamEvent | 'end'>) {
    this.queue.push(...events);
    this.wake?.();
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    this.requests.push(request);
    while (true) {
      if (signal.aborted) return;
      const next = this.queue.shift();
      if (next === 'end') return;
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      this.wake = null;
    }
  }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeout = 1000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await tick(2);
  }
}

function setup(options: { key?: string | null; consent?: boolean } = {}) {
  const store = new Store<PanelState>({
    ...initialState,
    ready: true,
    settings: { ...DEFAULT_SETTINGS, consentAt: options.consent === false ? null : 1 },
    newChat: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  });
  const saved = { messages: new Map<string, Message>(), conversations: new Map<string, Conversation>(), snapshots: new Set<string>() };
  const provider = new ControlledProvider();
  const deps: RequestDeps = {
    store,
    async saveTurn(input) {
      saved.conversations.set(input.conversation.id, input.conversation);
      for (const message of input.messages) saved.messages.set(message.id, message);
      if (input.snapshot) saved.snapshots.add(input.snapshot.id);
    },
    async saveMessage(message) {
      saved.messages.set(message.id, message);
    },
    async saveConversation(conversation) {
      saved.conversations.set(conversation.id, conversation);
    },
    getProvider: () => provider,
    loadApiKey: async () => (options.key === undefined ? 'sk-ant-test' : options.key),
    locks: null,
    flushMs: 1,
    persistMs: 0,
  };
  const manager = new RequestManager(deps);
  const assistantOf = (conversationId: string): AssistantMessage[] =>
    (store.get().messages[conversationId] ?? []).filter((m): m is AssistantMessage => m.role === 'assistant');
  return { store, saved, provider, manager, assistantOf };
}

function setDraft(store: Store<PanelState>, key: string, text: string, withSnapshot = false) {
  const attachment = withSnapshot ? stored(snapshot([el({ id: 'E1', role: 'target' }), el({ id: 'E2', role: 'ancestor', depth: 1 })]), '') : null;
  store.set((s) => ({ ...s, drafts: { ...s.drafts, [key]: { text, attachment } } }));
}

describe('RequestManager', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it('질문을 저장하고 스트림을 받아 완료 상태와 사용량을 남긴다', async () => {
    setDraft(env.store, NEW_KEY, '왜 넘칠까?', true);
    const result = await env.manager.send(NEW_KEY, '왜 넘칠까?');
    expect(result.ok).toBe(true);
    const id = (result as { conversationId: string }).conversationId;
    expect(env.store.get().activeId).toBe(id);
    expect(env.saved.snapshots.size).toBe(1);
    env.provider.push({ type: 'status', phase: 'writing' }, { type: 'text', text: '원인은 ' }, { type: 'text', text: '[E1]입니다' });
    await until(() => env.assistantOf(id)[0]?.text === '원인은 [E1]입니다');
    expect(env.assistantOf(id)[0]?.status).toBe('streaming');
    env.provider.push({ type: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
    await until(() => env.assistantOf(id)[0]?.status === 'complete');
    const final = env.saved.messages.get(env.assistantOf(id)[0]!.id) as AssistantMessage;
    expect(final.status).toBe('complete');
    expect(final.text).toBe('원인은 [E1]입니다');
    expect(final.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(env.provider.requests[0]?.turns.at(-1)?.text).toContain('<page_snapshot');
    expect(env.provider.requests[0]?.turns.at(-1)?.text).toContain('질문: 왜 넘칠까?');
  });

  it('보내는 중 두 번 눌러도 질문은 하나만 저장한다', async () => {
    setDraft(env.store, NEW_KEY, '질문');
    const [a, b] = await Promise.all([env.manager.send(NEW_KEY, '질문'), env.manager.send(NEW_KEY, '질문')]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([...env.saved.messages.values()].filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('같은 대화에서 생성 중이면 새 질문을 받지 않는다', async () => {
    const first = await env.manager.send(NEW_KEY, '첫 질문');
    const id = (first as { conversationId: string }).conversationId;
    expect(env.manager.isBusy(id)).toBe(true);
    const second = await env.manager.send(id, '두 번째');
    expect(second).toEqual({ ok: false, reason: 'busy' });
  });

  it('중단하면 받은 부분을 보존하고 cancelled로 남긴다', async () => {
    const result = await env.manager.send(NEW_KEY, '질문');
    const id = (result as { conversationId: string }).conversationId;
    env.provider.push({ type: 'text', text: '부분 응답' });
    await until(() => env.assistantOf(id)[0]?.text === '부분 응답');
    env.manager.cancel(id);
    await until(() => env.assistantOf(id)[0]?.status === 'cancelled');
    expect(env.assistantOf(id)[0]?.text).toBe('부분 응답');
    expect((env.saved.messages.get(env.assistantOf(id)[0]!.id) as AssistantMessage).status).toBe('cancelled');
    expect(env.manager.isBusy(id)).toBe(false);
  });

  it('연결 끊김은 interrupted로, 거절은 부분 응답을 지운 error로 구분한다', async () => {
    const first = await env.manager.send(NEW_KEY, '질문');
    const id = (first as { conversationId: string }).conversationId;
    env.provider.push({ type: 'text', text: '반쯤' }, { type: 'interrupted', reason: 'network', detail: 'net' });
    await until(() => env.assistantOf(id)[0]?.status === 'interrupted');
    expect(env.assistantOf(id)[0]).toMatchObject({ text: '반쯤', interruptReason: 'network' });

    const env2 = setup();
    const second = await env2.manager.send(NEW_KEY, '질문');
    const id2 = (second as { conversationId: string }).conversationId;
    env2.provider.push(
      { type: 'text', text: '거절 전 글' },
      { type: 'error', discardPartial: true, error: { kind: 'refusal', message: '거절', retryable: false } },
    );
    await until(() => env2.assistantOf(id2)[0]?.status === 'error');
    expect(env2.assistantOf(id2)[0]?.text).toBe('');
  });

  it('생성 중에 다른 대화로 옮겨도 응답은 원래 대화에만 붙는다', async () => {
    const result = await env.manager.send(NEW_KEY, '대화 A 질문');
    const a = (result as { conversationId: string }).conversationId;
    env.store.set((s) => ({ ...s, activeId: 'other', messages: { ...s.messages, other: [] } }));
    env.provider.push({ type: 'text', text: 'A의 답' }, { type: 'done', stopReason: 'end_turn' });
    await until(() => env.assistantOf(a)[0]?.status === 'complete');
    expect(env.assistantOf(a)[0]?.text).toBe('A의 답');
    expect(env.store.get().messages.other).toEqual([]);
    expect(env.store.get().activeId).toBe('other');
  });

  it('키가 없거나 동의 전이면 요청하지 않고 오류로 남긴다', async () => {
    const noKey = setup({ key: null });
    const r1 = await noKey.manager.send(NEW_KEY, '질문');
    const id1 = (r1 as { conversationId: string }).conversationId;
    await until(() => noKey.assistantOf(id1)[0]?.status === 'error');
    expect(noKey.assistantOf(id1)[0]?.error?.kind).toBe('missing_key');
    expect(noKey.provider.requests).toHaveLength(0);

    const noConsent = setup({ consent: false });
    const r2 = await noConsent.manager.send(NEW_KEY, '질문');
    const id2 = (r2 as { conversationId: string }).conversationId;
    await until(() => noConsent.assistantOf(id2)[0]?.status === 'error');
    expect(noConsent.assistantOf(id2)[0]?.error?.kind).toBe('consent_required');
  });

  it('재시도는 새 답변을 덧붙이고, 실패한 부분 응답은 이력으로 보내지 않는다', async () => {
    const result = await env.manager.send(NEW_KEY, '질문');
    const id = (result as { conversationId: string }).conversationId;
    env.provider.push({ type: 'text', text: '실패한 부분' }, { type: 'error', error: { kind: 'server', message: '서버', retryable: true } });
    await until(() => env.assistantOf(id)[0]?.status === 'error');
    const failedId = env.assistantOf(id)[0]!.id;
    expect(await env.manager.retry(id, failedId)).toBe(true);
    env.provider.push({ type: 'text', text: '새 답' }, { type: 'done', stopReason: 'end_turn' });
    await until(() => env.assistantOf(id)[1]?.status === 'complete');
    expect(env.assistantOf(id).map((m) => m.status)).toEqual(['error', 'complete']);
    const retryTurns = env.provider.requests[1]!.turns;
    expect(retryTurns).toHaveLength(1);
    expect(retryTurns[0]!.text).not.toContain('실패한 부분');
  });

  it('완료된 마지막 답변이나 마지막이 아닌 답변은 재시도하지 않는다', async () => {
    const result = await env.manager.send(NEW_KEY, '질문');
    const id = (result as { conversationId: string }).conversationId;
    env.provider.push({ type: 'done', stopReason: 'end_turn' });
    await until(() => env.assistantOf(id)[0]?.status === 'complete');
    expect(await env.manager.retry(id, env.assistantOf(id)[0]!.id)).toBe(false);
  });

  it('끝난 뒤 늦게 온 이벤트는 무시한다', async () => {
    const result = await env.manager.send(NEW_KEY, '질문');
    const id = (result as { conversationId: string }).conversationId;
    env.provider.push({ type: 'done', stopReason: 'end_turn' }, { type: 'text', text: '늦은 글' });
    await until(() => env.assistantOf(id)[0]?.status === 'complete');
    await tick(10);
    expect(env.assistantOf(id)[0]?.text).toBe('');
  });
});
