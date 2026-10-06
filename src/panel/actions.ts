/**
 * 패널 동작 모음. 컴포넌트는 이 함수들만 부르고, 상태는 store에서 읽는다.
 */
import type { AssistantMessage, Conversation, ProviderId } from '../shared/conversation';
import { isActive } from '../shared/conversation';
import { makeId } from '../shared/ids';
import { NO_EXCLUSIONS, type Snapshot, type SnapshotExclusions, type StoredSnapshot } from '../shared/snapshot';
import { defaultModel, getProvider, PROVIDERS } from '../providers/registry';
import * as db from '../storage/db';
import { deleteApiKey, getKeyStatus, loadApiKey, saveApiKey, type KeyPersistence } from '../storage/secrets';
import { loadSettings, saveSettings, type Settings } from '../storage/settings';
import { ContentBridge, isRestrictedUrl, NoAccessError, PageGoneError, RestrictedPageError, type PortSession } from './bridge';
import { lockName, RequestManager } from './requests';
import { NEW_KEY, draftKey, emptyDraft, pushNotice, store, upsertConversation, type DraftState, type LiveStatus, type PanelState, type View } from './store';

export const bridge = new ContentBridge();

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('noodlelens') : null;

function announce(conversationId: string | null) {
  channel?.postMessage({ type: 'changed', conversationId });
}

export const requests = new RequestManager({
  store,
  saveTurn: db.saveTurn,
  saveMessage: db.saveMessage,
  saveConversation: db.saveConversation,
  getProvider,
  loadApiKey,
  locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null,
  onChanged: (conversationId) => announce(conversationId),
});

function set(updater: (s: PanelState) => PanelState) {
  store.set(updater);
}

function setDraft(key: string, patch: Partial<DraftState>) {
  set((s) => ({ ...s, drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? emptyDraft()), ...patch } } }));
}

function currentConversation(state = store.get()): Conversation | undefined {
  return state.activeId ? state.conversations.find((c) => c.id === state.activeId) : undefined;
}

// ───────────────────────── 초기화 ─────────────────────────

/** 다른 창의 패널이 닫히며 남긴 '생성 중' 답변을 끊김으로 정리한다 */
async function recoverOrphans() {
  const active = await db.listActiveAssistantMessages();
  if (active.length === 0) return;
  const held = new Set(
    navigator.locks ? ((await navigator.locks.query()).held ?? []).map((lock) => lock.name) : [],
  );
  const now = Date.now();
  for (const message of active) {
    if (held.has(lockName(message.conversationId))) continue;
    await db.saveMessage({ ...message, status: 'interrupted', interruptReason: 'panel-closed', updatedAt: now, finishedAt: now });
  }
}

async function refreshKeyStatus() {
  const [openai, anthropic] = await Promise.all([getKeyStatus('openai'), getKeyStatus('anthropic')]);
  set((s) => ({ ...s, keyStatus: { openai, anthropic } }));
}

/** 개발 빌드에서만: 패널을 일반 탭으로 열어 시험할 때 대상 탭을 지정한다(?tabId=) */
function devTargetTab(): number | null {
  if (!__NL_DEV__) return null;
  const value = new URLSearchParams(location.search).get('tabId');
  return value ? Number(value) : null;
}

export async function refreshActiveTab() {
  try {
    let windowId = store.get().tab.windowId;
    if (windowId === null) windowId = (await chrome.windows.getCurrent()).id ?? null;
    const devTab = devTargetTab();
    const tab = devTab !== null ? await chrome.tabs.get(devTab) : (await chrome.tabs.query({ active: true, windowId: windowId ?? undefined }))[0];
    const url = tab?.url || tab?.pendingUrl;
    const access = !tab ? 'none' : !url ? 'unknown' : isRestrictedUrl(url) ? 'restricted' : 'granted';
    set((s) => ({
      ...s,
      tab: { windowId, tabId: tab?.id ?? null, url, title: url ? tab?.title : undefined, access },
    }));
  } catch {
    set((s) => ({ ...s, tab: { ...s.tab, tabId: null, access: 'none' } }));
  }
}

function watchTabs() {
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (devTargetTab() === null && windowId === store.get().tab.windowId) void refreshActiveTab();
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== store.get().tab.tabId) return;
    if (info.status === 'complete' || info.url !== undefined || info.title !== undefined || info.status === 'loading') {
      void refreshActiveTab();
    }
    // 페이지 로딩이 끝나면 대상 요소가 아직 있는지 다시 본다(뒤로 가기 복원 포함).
    if (info.status === 'complete') {
      const target = visibleTargetSnapshot();
      if (target && target.source.tabId === tabId) void checkLive(target.id);
    }
  });
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const m = message as { type?: string; windowId?: number };
    if (m?.type === 'noodlelens/action-clicked' && m.windowId === store.get().tab.windowId) void refreshActiveTab();
  });
  chrome.permissions.onAdded.addListener(() => void refreshActiveTab());
}

function watchOtherPanels() {
  channel?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; conversationId?: string | null };
    if (data?.type !== 'changed') return;
    void reloadFromDb(data.conversationId ?? null);
  });
}

/** 다른 창의 패널이 바꾼 내용을 다시 읽는다. 이 패널에서 생성 중인 대화는 건드리지 않는다. */
async function reloadFromDb(conversationId: string | null) {
  const conversations = await db.listConversations();
  set((s) => ({ ...s, conversations }));
  if (!conversationId || !store.get().messages[conversationId] || requests.isBusy(conversationId)) return;
  if (!conversations.some((c) => c.id === conversationId)) {
    set((s) => {
      const messages = { ...s.messages };
      delete messages[conversationId];
      return { ...s, messages, activeId: s.activeId === conversationId ? null : s.activeId };
    });
    return;
  }
  await loadConversation(conversationId);
}

export async function init() {
  try {
    const settings = await loadSettings();
    set((s) => ({
      ...s,
      settings,
      newChat: { provider: settings.defaultProvider, model: settings.models[settings.defaultProvider] ?? defaultModel(settings.defaultProvider) },
    }));
    await recoverOrphans();
    const conversations = await db.listConversations();
    set((s) => ({ ...s, conversations }));
    await refreshKeyStatus();
    await refreshActiveTab();
    watchTabs();
    watchOtherPanels();
    window.addEventListener('pagehide', () => {
      requests.abandonAll();
      bridge.closeAll();
    });
    set((s) => ({ ...s, ready: true }));
  } catch (error) {
    set((s) => ({ ...s, ready: true, loadError: String((error as Error)?.message ?? error) }));
  }
}

// ───────────────────────── 화면 전환 ─────────────────────────

export function setView(view: View) {
  set((s) => ({ ...s, view }));
}

async function loadConversation(id: string) {
  const [messages, snapshots] = await Promise.all([db.listMessages(id), db.listSnapshots(id)]);
  set((s) => ({
    ...s,
    messages: { ...s.messages, [id]: messages },
    snapshots: { ...s.snapshots, ...Object.fromEntries(snapshots.map((snap) => [snap.id, snap])) },
  }));
}

export async function openConversation(id: string) {
  if (!store.get().messages[id]) await loadConversation(id);
  set((s) => ({ ...s, activeId: id, view: 'chat' }));
  const conversation = store.get().conversations.find((c) => c.id === id);
  if (conversation?.lastSnapshotId) void checkLive(conversation.lastSnapshotId);
}

export function newAnalysis(next?: { provider: ProviderId; model: string }) {
  set((s) => {
    const drafts = { ...s.drafts };
    delete drafts[NEW_KEY];
    return {
      ...s,
      activeId: null,
      view: 'chat',
      drafts,
      newChat: next ?? { provider: s.settings.defaultProvider, model: s.settings.models[s.settings.defaultProvider] ?? defaultModel(s.settings.defaultProvider) },
    };
  });
}

async function persistSettings(patch: Partial<Settings>) {
  const settings = { ...store.get().settings, ...patch };
  set((s) => ({ ...s, settings }));
  await saveSettings(settings);
}

/**
 * 모델 선택. 같은 제공자면 지금 대화의 모델만 바꾼다(다음 질문부터 적용).
 * 다른 제공자면 기존 대화를 그 제공자로 보내지 않고 새 분석을 시작한다. 지금 대상 요소는 다시 수집해 첨부한다.
 */
export async function chooseModel(provider: ProviderId, model: string) {
  const state = store.get();
  await persistSettings({ defaultProvider: provider, models: { ...state.settings.models, [provider]: model } });
  const conversation = currentConversation(state);
  if (!conversation) {
    set((s) => ({ ...s, newChat: { provider, model } }));
    return;
  }
  if (conversation.provider === provider) {
    const updated = { ...conversation, model };
    await db.saveConversation(updated);
    set((s) => upsertConversation(s, updated));
    announce(updated.id);
    return;
  }
  const carry = state.drafts[conversation.id]?.attachment ?? (conversation.lastSnapshotId ? state.snapshots[conversation.lastSnapshotId] : undefined);
  newAnalysis({ provider, model });
  if (carry) await recollect(carry, NEW_KEY, { quiet: true });
}

// ───────────────────────── 요소 선택 ─────────────────────────

function idOffsetFor(key: string): number {
  if (key === NEW_KEY) return 0;
  return store.get().conversations.find((c) => c.id === key)?.maxElementNumber ?? 0;
}

function toStored(snapshot: Snapshot, key: string, session: PortSession): StoredSnapshot {
  return {
    ...snapshot,
    conversationId: key === NEW_KEY ? '' : key,
    source: { tabId: session.tabId, frameId: 0, documentId: session.documentId },
    exclusions: { ...NO_EXCLUSIONS, elementIds: [] },
    savedAt: 0,
  };
}

function attachSnapshot(key: string, snapshot: StoredSnapshot) {
  set((s) => ({
    ...s,
    snapshots: { ...s.snapshots, [snapshot.id]: snapshot },
    drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? emptyDraft()), attachment: snapshot } },
    live: { ...s.live, [snapshot.id]: 'connected' },
  }));
}

function watchSessionClose(session: PortSession) {
  session.onClose(() => {
    set((s) => {
      const live = { ...s.live };
      let changed = false;
      for (const snap of Object.values(s.snapshots)) {
        if (snap.source.documentId === session.documentId && live[snap.id] !== 'page-gone') {
          live[snap.id] = 'page-gone';
          changed = true;
        }
      }
      return changed ? { ...s, live } : s;
    });
  });
}

function explainAccessError(error: unknown) {
  if (error instanceof NoAccessError) {
    set((s) => ({ ...s, tab: { ...s.tab, access: 'unknown' } }));
    pushNotice(
      {
        tone: 'error',
        text: '이 탭에는 아직 접근 권한이 없습니다. 툴바의 NoodleLens 아이콘을 한 번 누르면 이 탭에서 요소를 선택할 수 있습니다.',
        action: { label: '모든 사이트 허용', run: requestAllSites },
      },
      12000,
    );
  } else if (error instanceof RestrictedPageError) {
    pushNotice({ tone: 'error', text: 'Chrome 내부 페이지·웹 스토어 등에서는 요소를 선택할 수 없습니다.' });
  } else if (error instanceof PageGoneError) {
    pushNotice({ tone: 'error', text: '페이지가 이동되었거나 닫혔습니다. 다시 시도해 주세요.' });
  } else {
    pushNotice({ tone: 'error', text: `요소 선택을 시작하지 못했습니다: ${String((error as Error)?.message ?? error)}` });
  }
}

/** 사용자 제스처 안에서 바로 호출해야 한다(버튼 클릭 핸들러) */
export function requestAllSites() {
  chrome.permissions
    .request({ origins: ['https://*/*', 'http://*/*'] })
    .then((granted) => {
      if (granted) pushNotice({ tone: 'success', text: '모든 사이트에서 요소를 선택할 수 있습니다. 설정에서 언제든 해제할 수 있습니다.' });
      void refreshActiveTab();
    })
    .catch((error) => pushNotice({ tone: 'error', text: `권한 요청 실패: ${String(error?.message ?? error)}` }));
}

export async function startPicking() {
  const state = store.get();
  if (state.picker.status !== 'idle') return;
  const tabId = state.tab.tabId;
  if (tabId === null) {
    pushNotice({ tone: 'error', text: '선택할 탭을 찾지 못했습니다.' });
    return;
  }
  if (state.tab.access === 'restricted') {
    explainAccessError(new RestrictedPageError());
    return;
  }
  const key = draftKey(state);
  const reqId = makeId('p');
  set((s) => ({ ...s, picker: { status: 'starting', tabId, reqId, conversationKey: key } }));
  let session: PortSession;
  try {
    session = await bridge.open(tabId);
  } catch (error) {
    set((s) => ({ ...s, picker: { status: 'idle' } }));
    explainAccessError(error);
    return;
  }
  watchSessionClose(session);
  const stop = () => {
    offMessage();
    offClose();
  };
  const offMessage = session.onMessage((message) => {
    if (message.reqId !== reqId) return;
    if (message.kind === 'picked') {
      stop();
      attachSnapshot(key, toStored(message.snapshot, key, session));
      set((s) => ({ ...s, picker: { status: 'idle' } }));
    } else if (message.kind === 'pick-cancelled') {
      stop();
      set((s) => ({ ...s, picker: { status: 'idle' } }));
      if (message.reason === 'tab-hidden') pushNotice({ tone: 'info', text: '탭을 바꿔 요소 선택을 취소했습니다.' });
      if (message.reason === 'pagehide') pushNotice({ tone: 'info', text: '페이지가 이동되어 요소 선택을 취소했습니다.' });
    } else if (message.kind === 'error') {
      stop();
      set((s) => ({ ...s, picker: { status: 'idle' } }));
      pushNotice({ tone: 'error', text: message.message });
    }
  });
  const offClose = session.onClose(() => {
    stop();
    if (store.get().picker.reqId === reqId) {
      set((s) => ({ ...s, picker: { status: 'idle' } }));
      pushNotice({ tone: 'info', text: '페이지가 이동되어 요소 선택을 취소했습니다.' });
    }
  });
  try {
    session.post({ kind: 'pick-start', reqId, idOffset: idOffsetFor(key) });
    set((s) => (s.picker.reqId === reqId ? { ...s, picker: { ...s.picker, status: 'picking' } } : s));
  } catch (error) {
    stop();
    set((s) => ({ ...s, picker: { status: 'idle' } }));
    explainAccessError(error);
  }
}

export function cancelPicking() {
  const { picker } = store.get();
  if (picker.status === 'idle' || !picker.reqId || picker.tabId === undefined) return;
  set((s) => ({ ...s, picker: { status: 'idle' } }));
  void bridge
    .open(picker.tabId)
    .then((session) => session.post({ kind: 'pick-cancel', reqId: picker.reqId! }))
    .catch(() => {});
}

async function sessionFor(snapshot: StoredSnapshot): Promise<PortSession> {
  if (!snapshot.source.documentId) throw new PageGoneError();
  // 이미 이동한 것으로 아는 문서는 짧게만 확인한다(뒤로 가기로 돌아왔을 수도 있어 시도는 한다).
  const knownGone = store.get().live[snapshot.id] === 'page-gone';
  const session = await bridge.reconnect(snapshot.source.tabId, snapshot.source.documentId, knownGone ? 700 : 1500);
  watchSessionClose(session);
  return session;
}

/** 지금 보이는 대상 스냅샷(전송 대기 첨부 또는 대화의 마지막 스냅샷) */
function visibleTargetSnapshot(state = store.get()): StoredSnapshot | undefined {
  const draft = state.drafts[draftKey(state)]?.attachment;
  if (draft) return draft;
  const conversation = currentConversation(state);
  return conversation?.lastSnapshotId ? state.snapshots[conversation.lastSnapshotId] : undefined;
}

/** 같은 요소를 지금 상태로 다시 잰다. 결과는 key 초안에 첨부한다. */
export async function recollect(snapshot: StoredSnapshot, key = draftKey(store.get()), options: { quiet?: boolean } = {}) {
  try {
    const session = await sessionFor(snapshot);
    const reqId = makeId('r');
    const reply = await session.request(
      { kind: 'recollect', reqId, snapshotId: snapshot.id, elementId: snapshot.targetId, idOffset: idOffsetFor(key) },
      8000,
    );
    if (reply.kind === 'recollected') {
      attachSnapshot(key, toStored(reply.snapshot, key, session));
      if (!options.quiet) pushNotice({ tone: 'success', text: '요소를 다시 수집했습니다. 다음 질문에 첨부됩니다.' }, 3000);
      return;
    }
    if (reply.kind === 'element-status-result') {
      set((s) => ({ ...s, live: { ...s.live, [snapshot.id]: reply.status } }));
      pushNotice({ tone: 'error', text: reply.status === 'detached' ? '요소가 페이지에서 사라졌습니다. 다시 선택해 주세요.' : '이전 수집 정보를 찾을 수 없습니다. 다시 선택해 주세요.' });
      return;
    }
    if (reply.kind === 'error') pushNotice({ tone: 'error', text: reply.message });
  } catch {
    set((s) => ({ ...s, live: { ...s.live, [snapshot.id]: 'page-gone' } }));
    if (!options.quiet) pushNotice({ tone: 'error', text: '수집한 페이지가 이동되었거나 닫혔습니다. 요소를 다시 선택해 주세요.' });
  }
}

export function removeAttachment(key = draftKey(store.get())) {
  setDraft(key, { attachment: null });
}

export function updateExclusions(snapshotId: string, patch: Partial<SnapshotExclusions>) {
  set((s) => {
    const key = draftKey(s);
    const draft = s.drafts[key];
    if (!draft?.attachment || draft.attachment.id !== snapshotId) return s;
    const attachment = { ...draft.attachment, exclusions: { ...draft.attachment.exclusions, ...patch } };
    return {
      ...s,
      drafts: { ...s.drafts, [key]: { ...draft, attachment } },
      snapshots: { ...s.snapshots, [snapshotId]: attachment },
    };
  });
}

export function toggleElementExclusion(snapshotId: string, elementId: string) {
  const snapshot = store.get().snapshots[snapshotId];
  if (!snapshot || elementId === snapshot.targetId) return;
  const ids = new Set(snapshot.exclusions.elementIds);
  if (ids.has(elementId)) ids.delete(elementId);
  else ids.add(elementId);
  updateExclusions(snapshotId, { elementIds: [...ids] });
}

export function openPreview(snapshotId: string | null) {
  set((s) => ({ ...s, previewSnapshotId: snapshotId }));
}

export async function checkLive(snapshotId: string): Promise<LiveStatus> {
  const snapshot = store.get().snapshots[snapshotId];
  if (!snapshot) return 'unknown';
  set((s) => ({ ...s, live: { ...s.live, [snapshotId]: s.live[snapshotId] ?? 'checking' } }));
  let status: LiveStatus;
  try {
    const session = await sessionFor(snapshot);
    const reqId = makeId('r');
    const reply = await session.request({ kind: 'element-status', reqId, snapshotId, elementId: snapshot.targetId }, 3000);
    status = reply.kind === 'element-status-result' ? reply.status : 'unknown';
  } catch {
    status = 'page-gone';
  }
  set((s) => ({ ...s, live: { ...s.live, [snapshotId]: status } }));
  return status;
}

/** 근거·대상 요소를 페이지에서 강조한다. 탭이 비활성이면 먼저 그 탭으로 옮긴다. */
export async function highlight(snapshotId: string, elementId: string) {
  const snapshot = store.get().snapshots[snapshotId];
  if (!snapshot) {
    pushNotice({ tone: 'error', text: `${elementId} 요소의 수집 자료를 찾을 수 없습니다.` });
    return;
  }
  try {
    const tab = await chrome.tabs.get(snapshot.source.tabId);
    if (!tab.active) await chrome.tabs.update(snapshot.source.tabId, { active: true });
    if (tab.windowId !== undefined && tab.windowId !== store.get().tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    set((s) => ({ ...s, live: { ...s.live, [snapshotId]: 'page-gone' } }));
    pushNotice({ tone: 'error', text: '수집한 탭이 닫혀 요소를 찾을 수 없습니다.' });
    return;
  }
  try {
    const session = await sessionFor(snapshot);
    const reqId = makeId('r');
    const reply = await session.request({ kind: 'highlight', reqId, snapshotId, elementId, scroll: true }, 4000);
    if (reply.kind !== 'highlight-result') return;
    if (elementId === snapshot.targetId) set((s) => ({ ...s, live: { ...s.live, [snapshotId]: reply.status } }));
    if (reply.status === 'detached') pushNotice({ tone: 'error', text: `${elementId} 요소가 더 이상 페이지에 없습니다(삭제되었거나 다시 그려짐). 다시 선택해 주세요.` });
    if (reply.status === 'unknown') pushNotice({ tone: 'error', text: `${elementId} 요소를 찾을 수 없습니다. 페이지를 새로 고쳤다면 다시 선택해 주세요.` });
  } catch {
    set((s) => ({ ...s, live: { ...s.live, [snapshotId]: 'page-gone' } }));
    pushNotice({ tone: 'error', text: `페이지가 이동되었거나 새로 고쳐져 ${elementId} 요소를 찾을 수 없습니다.` });
  }
}

// ───────────────────────── 대화 ─────────────────────────

export function setDraftText(text: string) {
  setDraft(draftKey(store.get()), { text });
}

export async function send() {
  const state = store.get();
  const key = draftKey(state);
  const text = state.drafts[key]?.text ?? '';
  const result = await requests.send(key, text);
  if (!result.ok && result.reason === 'locked') {
    pushNotice({ tone: 'error', text: '다른 창의 패널에서 이 대화의 답변을 생성 중입니다.' });
  } else if (!result.ok && result.reason === 'failed') {
    pushNotice({ tone: 'error', text: '질문을 저장하지 못했습니다. 다시 시도해 주세요.' });
  }
}

export function cancel(conversationId: string) {
  requests.cancel(conversationId);
}

export async function retry(conversationId: string, messageId: string) {
  const ok = await requests.retry(conversationId, messageId);
  if (!ok) pushNotice({ tone: 'error', text: '지금은 다시 시도할 수 없습니다(다른 요청이 진행 중이거나 마지막 답변이 아닙니다).' });
}

export function isConversationBusy(state: PanelState, conversationId: string | null): boolean {
  if (!conversationId) return false;
  const last = state.messages[conversationId]?.findLast((m) => m.role === 'assistant') as AssistantMessage | undefined;
  return Boolean(last && isActive(last.status));
}

export async function deleteConversation(id: string) {
  requests.cancel(id);
  await db.deleteConversation(id);
  set((s) => {
    const messages = { ...s.messages };
    delete messages[id];
    const drafts = { ...s.drafts };
    delete drafts[id];
    const snapshots = Object.fromEntries(Object.entries(s.snapshots).filter(([, snap]) => snap.conversationId !== id));
    return {
      ...s,
      conversations: s.conversations.filter((c) => c.id !== id),
      messages,
      drafts,
      snapshots,
      activeId: s.activeId === id ? null : s.activeId,
    };
  });
  announce(id);
}

export async function deleteAllConversations() {
  for (const conversation of store.get().conversations) requests.cancel(conversation.id);
  await db.deleteAllConversations();
  set((s) => ({
    ...s,
    conversations: [],
    messages: {},
    drafts: {},
    snapshots: {},
    activeId: null,
  }));
  announce(null);
}

// ───────────────────────── 설정 ─────────────────────────

export async function storeKey(provider: 'openai' | 'anthropic', key: string, persistence: KeyPersistence) {
  await saveApiKey(provider, key, persistence);
  await refreshKeyStatus();
}

export async function removeKey(provider: 'openai' | 'anthropic') {
  await deleteApiKey(provider);
  await refreshKeyStatus();
}

export async function acceptConsent() {
  await persistSettings({ consentAt: Date.now() });
}

export async function setShowMock(showMock: boolean) {
  await persistSettings({ showMock });
  if (!showMock) {
    const state = store.get();
    if (state.newChat.provider === 'mock') newAnalysis({ provider: 'anthropic', model: state.settings.models.anthropic ?? defaultModel('anthropic') });
  }
}

export async function revokeAllSites() {
  const removed = await chrome.permissions.remove({ origins: ['https://*/*', 'http://*/*'] });
  pushNotice({ tone: 'info', text: removed ? '모든 사이트 접근 권한을 해제했습니다.' : '해제할 사이트 권한이 없습니다.' });
  void refreshActiveTab();
}

export async function hasAllSites(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] });
  } catch {
    return false;
  }
}

export function providerReady(state: PanelState, provider: ProviderId): boolean {
  if (provider === 'mock') return true;
  return state.keyStatus[provider].present;
}

export { PROVIDERS };
