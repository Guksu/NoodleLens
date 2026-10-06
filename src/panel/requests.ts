/**
 * 모델 요청 관리자. 요청은 사이드 패널 페이지가 소유한다.
 *
 * - 대화마다 동시에 하나의 요청만 둔다(중복 전송 방지). 다른 창의 패널과는 Web Locks로 겹치지 않게 한다.
 * - 응답 조각은 요청을 시작한 대화의 답변 메시지(id)에만 붙는다. 화면에서 다른 대화를 보고 있어도 섞이지 않는다.
 * - 받은 내용은 주기적으로 IndexedDB에 저장한다. 패널이 닫히면 다음에 열 때 '끊김'으로 정리한다.
 * - 취소(cancelled), 연결 끊김(interrupted), 오류(error), 완료(complete)를 구분하고 부분 응답을 보존한다.
 */
import type { AssistantMessage, Conversation, Message, MessageError, UserMessage } from '../shared/conversation';
import { isTerminal } from '../shared/conversation';
import { makeId } from '../shared/ids';
import type { StoredSnapshot } from '../shared/snapshot';
import { elementIdNumber } from '../shared/snapshot';
import { clip, collapseWhitespace } from '../shared/text';
import { makeError } from '../providers/errors';
import { buildTurns, SYSTEM_PROMPT } from '../providers/prompt';
import type { ChatProvider } from '../providers/types';
import type { ProviderId } from '../shared/conversation';
import { NEW_KEY, emptyDraft, patchMessage, upsertConversation, type PanelState, type Store } from './store';

export interface RequestDeps {
  store: Store<PanelState>;
  saveTurn(input: { conversation: Conversation; messages: Message[]; snapshot?: StoredSnapshot }): Promise<void>;
  saveMessage(message: Message): Promise<void>;
  saveConversation(conversation: Conversation): Promise<void>;
  getProvider(id: ProviderId): ChatProvider;
  loadApiKey(provider: ProviderId): Promise<string | null>;
  locks?: LockManager | null;
  onChanged?(conversationId: string): void;
  now?(): number;
  flushMs?: number;
  persistMs?: number;
}

interface Running {
  conversationId: string;
  messageId: string;
  controller: AbortController;
  text: string;
  usage: AssistantMessage['usage'];
  firstTokenAt?: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastPersist: number;
  done: boolean;
}

export type SendResult = { ok: true; conversationId: string } | { ok: false; reason: 'busy' | 'empty' | 'locked' | 'failed' };

export const lockName = (conversationId: string) => `nl-conv-${conversationId}`;

export function makeTitle(text: string): string {
  return clip(collapseWhitespace(text), 48) || '새 분석';
}

function maxElementNumber(snapshot: StoredSnapshot): number {
  return snapshot.elements.reduce((max, el) => Math.max(max, elementIdNumber(el.id) || 0), 0);
}

export class RequestManager {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Set<string>();

  constructor(private readonly deps: RequestDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  isBusy(conversationId: string | null): boolean {
    if (conversationId === null) return this.starting.has(NEW_KEY);
    return this.running.has(conversationId) || this.starting.has(conversationId);
  }

  private async heldElsewhere(conversationId: string): Promise<boolean> {
    const locks = this.deps.locks;
    if (!locks) return false;
    const snapshot = await locks.query();
    return (snapshot.held ?? []).some((lock) => lock.name === lockName(conversationId));
  }

  /** 초안(질문·첨부)을 보내고 답변 생성을 시작한다. 생성 완료를 기다리지 않는다. */
  async send(key: string, rawText: string): Promise<SendResult> {
    const text = rawText.trim();
    if (!text) return { ok: false, reason: 'empty' };
    const existingId = key === NEW_KEY ? null : key;
    if (this.starting.has(key) || (existingId && this.running.has(existingId))) return { ok: false, reason: 'busy' };
    this.starting.add(key);
    try {
      if (existingId && (await this.heldElsewhere(existingId))) return { ok: false, reason: 'locked' };
      const { store } = this.deps;
      const state = store.get();
      const attachment = state.drafts[key]?.attachment ?? null;
      const now = this.now();
      let conversation: Conversation;
      if (existingId) {
        const found = state.conversations.find((c) => c.id === existingId);
        if (!found) return { ok: false, reason: 'failed' };
        conversation = { ...found };
      } else {
        conversation = {
          id: makeId('c'),
          title: makeTitle(text),
          provider: state.newChat.provider,
          model: state.newChat.model,
          createdAt: now,
          updatedAt: now,
          maxElementNumber: 0,
        };
      }
      let snapshot: StoredSnapshot | undefined;
      if (attachment) {
        snapshot = { ...attachment, conversationId: conversation.id, savedAt: now };
        const target = snapshot.elements.find((el) => el.id === snapshot!.targetId);
        conversation = {
          ...conversation,
          lastSnapshotId: snapshot.id,
          pageUrl: snapshot.page.url,
          pageTitle: snapshot.page.title,
          targetLabel: target?.label,
          maxElementNumber: Math.max(conversation.maxElementNumber, maxElementNumber(snapshot)),
        };
      }
      conversation.updatedAt = now;
      const user: UserMessage = {
        id: makeId('m'),
        conversationId: conversation.id,
        role: 'user',
        text,
        createdAt: now,
        ...(snapshot ? { snapshotId: snapshot.id } : {}),
      };
      const assistant: AssistantMessage = {
        id: makeId('m'),
        conversationId: conversation.id,
        role: 'assistant',
        replyTo: user.id,
        provider: conversation.provider,
        model: conversation.model,
        text: '',
        status: 'pending',
        createdAt: now + 1,
        updatedAt: now + 1,
        ...(conversation.provider === 'mock' ? { mock: true } : {}),
      };
      await this.deps.saveTurn({ conversation, messages: [user, assistant], snapshot });
      const conversationId = conversation.id;
      store.set((s) => {
        let next = upsertConversation(s, conversation);
        const drafts = { ...next.drafts };
        delete drafts[key];
        drafts[conversationId] = { ...emptyDraft() };
        next = {
          ...next,
          // 저장하는 동안 사용자가 다른 대화로 옮겼다면 화면을 빼앗지 않는다.
          activeId: s.activeId === existingId ? conversationId : s.activeId,
          messages: { ...next.messages, [conversationId]: [...(next.messages[conversationId] ?? []), user, assistant] },
          snapshots: snapshot ? { ...next.snapshots, [snapshot.id]: snapshot } : next.snapshots,
          drafts,
        };
        return next;
      });
      this.deps.onChanged?.(conversationId);
      void this.run(conversation, assistant);
      return { ok: true, conversationId };
    } catch {
      return { ok: false, reason: 'failed' };
    } finally {
      this.starting.delete(key);
    }
  }

  /** 마지막 답변이 실패·중단·끊김일 때 같은 질문으로 다시 요청한다. 이전 시도는 기록으로 남긴다. */
  async retry(conversationId: string, failedMessageId: string): Promise<boolean> {
    if (this.isBusy(conversationId)) return false;
    this.starting.add(conversationId);
    try {
      if (await this.heldElsewhere(conversationId)) return false;
      const state = this.deps.store.get();
      const list = state.messages[conversationId] ?? [];
      const failed = list.find((m) => m.id === failedMessageId);
      const last = list.at(-1);
      const conversation = state.conversations.find((c) => c.id === conversationId);
      if (!conversation || !failed || failed.role !== 'assistant' || last?.id !== failed.id) return false;
      if (!isTerminal(failed.status) || failed.status === 'complete') return false;
      const now = this.now();
      const assistant: AssistantMessage = {
        id: makeId('m'),
        conversationId,
        role: 'assistant',
        replyTo: failed.replyTo,
        provider: conversation.provider,
        model: conversation.model,
        text: '',
        status: 'pending',
        createdAt: Math.max(now, failed.createdAt + 1),
        updatedAt: now,
        ...(conversation.provider === 'mock' ? { mock: true } : {}),
      };
      await this.deps.saveMessage(assistant);
      this.deps.store.set((s) => ({
        ...s,
        messages: { ...s.messages, [conversationId]: [...(s.messages[conversationId] ?? []), assistant] },
      }));
      void this.run(conversation, assistant);
      return true;
    } finally {
      this.starting.delete(conversationId);
    }
  }

  cancel(conversationId: string) {
    this.running.get(conversationId)?.controller.abort();
  }

  /** 패널이 닫힐 때 진행 중인 요청을 '패널 닫힘'으로 남기려 시도한다(저장이 끝나지 못할 수 있음). */
  abandonAll() {
    for (const running of this.running.values()) {
      if (running.done) continue;
      running.done = true;
      const message = this.findMessage(running.conversationId, running.messageId);
      if (message) {
        void this.deps.saveMessage({
          ...message,
          text: running.text,
          status: 'interrupted',
          interruptReason: 'panel-closed',
          updatedAt: this.now(),
          finishedAt: this.now(),
        });
      }
      running.controller.abort();
    }
  }

  private findMessage(conversationId: string, messageId: string): AssistantMessage | undefined {
    const message = this.deps.store.get().messages[conversationId]?.find((m) => m.id === messageId);
    return message?.role === 'assistant' ? message : undefined;
  }

  private async run(conversation: Conversation, assistant: AssistantMessage) {
    const running: Running = {
      conversationId: conversation.id,
      messageId: assistant.id,
      controller: new AbortController(),
      text: '',
      usage: undefined,
      flushTimer: null,
      lastPersist: 0,
      done: false,
    };
    this.running.set(conversation.id, running);
    const body = () => this.stream(conversation, assistant, running);
    try {
      if (this.deps.locks) {
        await this.deps.locks.request(lockName(conversation.id), { ifAvailable: true }, async (lock) => {
          if (!lock) {
            await this.finish(running, { status: 'error', error: makeError('unknown', '다른 창에서 이 대화의 응답을 생성 중입니다.') });
            return;
          }
          await body();
        });
      } else {
        await body();
      }
    } finally {
      if (this.running.get(conversation.id) === running) this.running.delete(conversation.id);
    }
  }

  private async stream(conversation: Conversation, assistant: AssistantMessage, running: Running) {
    const { store } = this.deps;
    const signal = running.controller.signal;
    try {
      const settings = store.get().settings;
      let apiKey = '';
      if (assistant.provider !== 'mock') {
        if (!settings.consentAt) {
          await this.finish(running, { status: 'error', error: makeError('consent_required') });
          return;
        }
        apiKey = (await this.deps.loadApiKey(assistant.provider)) ?? '';
        if (!apiKey) {
          await this.finish(running, { status: 'error', error: makeError('missing_key') });
          return;
        }
      }
      const state = store.get();
      const turns = buildTurns(
        state.messages[conversation.id] ?? [],
        new Map(Object.entries(state.snapshots)),
        assistant.replyTo,
      );
      this.patch(running, { startedAt: this.now() });
      const provider = this.deps.getProvider(assistant.provider);
      for await (const event of provider.stream(
        { model: assistant.model, system: SYSTEM_PROMPT, turns, maxOutputTokens: settings.maxOutputTokens, apiKey },
        signal,
      )) {
        if (running.done) return;
        switch (event.type) {
          case 'status':
            store.set((s) => ({ ...s, phases: { ...s.phases, [assistant.id]: event.phase } }));
            break;
          case 'text':
            running.text += event.text;
            running.firstTokenAt ??= this.now();
            this.scheduleFlush(running);
            break;
          case 'usage':
            running.usage = { ...running.usage, ...event.usage };
            break;
          case 'done':
            await this.finish(running, {
              status: 'complete',
              stopReason: event.stopReason,
              usage: { ...running.usage, ...event.usage },
            });
            return;
          case 'error':
            await this.finish(running, {
              status: 'error',
              error: event.error,
              ...(event.discardPartial ? { text: '' } : {}),
            });
            return;
          case 'interrupted':
            await this.finish(running, {
              status: 'interrupted',
              interruptReason: event.reason,
              error: makeError('network', event.detail ?? (event.reason === 'stream-ended' ? '응답이 끝나기 전에 스트림이 닫혔습니다' : undefined)),
            });
            return;
        }
      }
      if (signal.aborted) await this.finish(running, { status: 'cancelled' });
      else await this.finish(running, { status: 'interrupted', interruptReason: 'stream-ended' });
    } catch (error) {
      if (signal.aborted) await this.finish(running, { status: 'cancelled' });
      else await this.finish(running, { status: 'error', error: makeError('unknown', (error as Error)?.message) });
    }
  }

  private patch(running: Running, patch: Partial<AssistantMessage>) {
    this.deps.store.set((s) => patchMessage(s, running.conversationId, running.messageId, patch));
  }

  private scheduleFlush(running: Running) {
    if (running.flushTimer) return;
    running.flushTimer = setTimeout(() => {
      running.flushTimer = null;
      if (running.done) return;
      const now = this.now();
      this.patch(running, {
        text: running.text,
        status: 'streaming',
        updatedAt: now,
        ...(running.firstTokenAt ? { firstTokenAt: running.firstTokenAt } : {}),
      });
      if (now - running.lastPersist >= (this.deps.persistMs ?? 500)) {
        running.lastPersist = now;
        const message = this.findMessage(running.conversationId, running.messageId);
        if (message) {
          void this.deps.saveMessage(message).then(() => this.deps.onChanged?.(running.conversationId));
        }
      }
    }, this.deps.flushMs ?? 50);
  }

  private async finish(
    running: Running,
    patch: Partial<Pick<AssistantMessage, 'status' | 'stopReason' | 'usage' | 'interruptReason' | 'text'>> & {
      status: AssistantMessage['status'];
      error?: MessageError;
    },
  ) {
    if (running.done) return;
    running.done = true;
    if (running.flushTimer) clearTimeout(running.flushTimer);
    running.flushTimer = null;
    const now = this.now();
    const current = this.findMessage(running.conversationId, running.messageId);
    if (!current) return;
    const final: AssistantMessage = {
      ...current,
      text: patch.text ?? running.text,
      status: patch.status,
      updatedAt: now,
      finishedAt: now,
      ...(running.firstTokenAt ? { firstTokenAt: running.firstTokenAt } : {}),
      ...(patch.error ? { error: patch.error } : {}),
      ...(patch.stopReason ? { stopReason: patch.stopReason } : {}),
      ...(patch.usage && Object.keys(patch.usage).length ? { usage: patch.usage } : {}),
      ...(patch.interruptReason ? { interruptReason: patch.interruptReason } : {}),
    };
    const { store } = this.deps;
    store.set((s) => {
      const phases = { ...s.phases };
      delete phases[running.messageId];
      return { ...patchMessage(s, running.conversationId, running.messageId, final), phases };
    });
    const conversation = store.get().conversations.find((c) => c.id === running.conversationId);
    try {
      await this.deps.saveMessage(final);
      if (conversation) {
        const updated = { ...conversation, updatedAt: now };
        await this.deps.saveConversation(updated);
        store.set((s) => upsertConversation(s, updated));
      }
    } finally {
      this.deps.onChanged?.(running.conversationId);
    }
  }
}
