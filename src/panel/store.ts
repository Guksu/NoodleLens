/**
 * 사이드 패널 상태. React 밖(요청 관리자·브리지)에서도 갱신하므로 작은 외부 저장소로 둔다.
 * 컴포넌트는 useStore(selector)로 필요한 부분만 구독한다.
 */
import { useRef, useSyncExternalStore } from 'react';
import type { Conversation, Message, ProviderId } from '../shared/conversation';
import type { ElementStatus } from '../shared/protocol';
import type { StoredSnapshot } from '../shared/snapshot';
import type { KeyStatus } from '../storage/secrets';
import { DEFAULT_SETTINGS, type Settings } from '../storage/settings';

export const NEW_KEY = 'new';

export type View = 'chat' | 'history' | 'settings';

export interface DraftState {
  text: string;
  /** 다음 질문과 함께 보낼 스냅샷(아직 저장 전) */
  attachment: StoredSnapshot | null;
}

export type TabAccess = 'granted' | 'unknown' | 'restricted' | 'none';

export interface ActiveTabState {
  windowId: number | null;
  tabId: number | null;
  url?: string;
  title?: string;
  access: TabAccess;
}

export type PickerStatus = 'idle' | 'starting' | 'picking';

export interface PickerState {
  status: PickerStatus;
  tabId?: number;
  reqId?: string;
  /** 선택이 끝나면 첨부할 대화 키 */
  conversationKey?: string;
}

export type LiveStatus = ElementStatus | 'page-gone' | 'checking';

export interface Notice {
  id: string;
  tone: 'info' | 'error' | 'success';
  text: string;
  action?: { label: string; run: () => void };
}

export interface PanelState {
  ready: boolean;
  loadError: string | null;
  view: View;
  settings: Settings;
  keyStatus: Record<'openai' | 'anthropic', KeyStatus>;
  conversations: Conversation[];
  /** null이면 아직 저장되지 않은 새 분석 */
  activeId: string | null;
  /** 새 분석에서 쓸 제공자·모델 */
  newChat: { provider: ProviderId; model: string };
  messages: Record<string, Message[]>;
  snapshots: Record<string, StoredSnapshot>;
  drafts: Record<string, DraftState>;
  tab: ActiveTabState;
  picker: PickerState;
  /** 응답 생성 단계(연결·추론·작성). 메시지 id 기준, 저장하지 않음 */
  phases: Record<string, 'connected' | 'thinking' | 'writing'>;
  /** 스냅샷 요소가 아직 페이지에 있는지. key = snapshotId */
  live: Record<string, LiveStatus>;
  previewSnapshotId: string | null;
  notices: Notice[];
}

export const initialState: PanelState = {
  ready: false,
  loadError: null,
  view: 'chat',
  settings: DEFAULT_SETTINGS,
  keyStatus: { openai: { present: false }, anthropic: { present: false } },
  conversations: [],
  activeId: null,
  newChat: { provider: DEFAULT_SETTINGS.defaultProvider, model: DEFAULT_SETTINGS.models[DEFAULT_SETTINGS.defaultProvider] },
  messages: {},
  snapshots: {},
  drafts: {},
  tab: { windowId: null, tabId: null, access: 'unknown' },
  picker: { status: 'idle' },
  phases: {},
  live: {},
  previewSnapshotId: null,
  notices: [],
};

type Listener = () => void;

export class Store<S> {
  private listeners = new Set<Listener>();

  constructor(private state: S) {}

  get = (): S => this.state;

  set = (updater: (state: S) => S) => {
    const next = updater(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const store = new Store<PanelState>(initialState);

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * 상태 일부를 구독한다. 선택자가 새 객체를 만들어도 equal이 같다고 보면 이전 값을 돌려줘
 * useSyncExternalStore가 무한히 다시 그리지 않게 한다. 객체를 고르는 선택자는 shallowEqual을 넘긴다.
 */
export function useStore<T>(selector: (state: PanelState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ state: PanelState; selector: (state: PanelState) => T; value: T } | null>(null);
  const getSnapshot = () => {
    const state = store.get();
    const cached = cache.current;
    if (cached && cached.state === state && cached.selector === selector) return cached.value;
    const value = selector(state);
    if (cached && equal(cached.value, value)) {
      cache.current = { state, selector, value: cached.value };
      return cached.value;
    }
    cache.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

export function draftKey(state: Pick<PanelState, 'activeId'>): string {
  return state.activeId ?? NEW_KEY;
}

export function emptyDraft(): DraftState {
  return { text: '', attachment: null };
}

/** 대화의 메시지 목록을 바꾼다(불변 갱신) */
export function patchMessage(state: PanelState, conversationId: string, messageId: string, patch: Partial<Message>): PanelState {
  const list = state.messages[conversationId];
  if (!list) return state;
  const index = list.findIndex((m) => m.id === messageId);
  if (index < 0) return state;
  const next = list.slice();
  next[index] = { ...list[index], ...patch } as Message;
  return { ...state, messages: { ...state.messages, [conversationId]: next } };
}

export function upsertConversation(state: PanelState, conversation: Conversation): PanelState {
  const others = state.conversations.filter((c) => c.id !== conversation.id);
  return { ...state, conversations: [conversation, ...others].sort((a, b) => b.updatedAt - a.updatedAt) };
}

let noticeSeq = 0;

export function pushNotice(notice: Omit<Notice, 'id'>, ttlMs = 6000) {
  const id = `n${(noticeSeq += 1)}`;
  store.set((s) => ({ ...s, notices: [...s.notices.slice(-2), { ...notice, id }] }));
  if (ttlMs > 0) setTimeout(() => dismissNotice(id), ttlMs);
}

export function dismissNotice(id: string) {
  store.set((s) => ({ ...s, notices: s.notices.filter((n) => n.id !== id) }));
}
