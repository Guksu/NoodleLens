/**
 * 사이드 패널 → content script 연결.
 *
 * 문서(documentId)마다 포트 하나를 연다. 포트가 끊기면 그 문서가 사라졌거나(페이지 이동·탭 닫힘)
 * content script가 무효가 된 것이므로 대기 중인 요청을 실패 처리한다.
 * content script가 보낸 메시지는 parseContentMessage로 검증한 뒤에만 쓴다.
 */
import { makeId } from '../shared/ids';
import { PORT_NAME, parseContentMessage, type ContentToPanel, type PanelToContent } from '../shared/protocol';

export class PageGoneError extends Error {
  constructor(message = '페이지가 이동되었거나 닫혀 연결할 수 없습니다.') {
    super(message);
    this.name = 'PageGoneError';
  }
}

export class NoAccessError extends Error {
  constructor(message = '이 탭에 접근할 권한이 없습니다.') {
    super(message);
    this.name = 'NoAccessError';
  }
}

export class RestrictedPageError extends Error {
  constructor(message = '이 페이지에서는 확장 프로그램이 동작할 수 없습니다.') {
    super(message);
    this.name = 'RestrictedPageError';
  }
}

type Pending = {
  resolve: (message: ContentToPanel) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export class PortSession {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(message: ContentToPanel) => void>();
  private readonly closeListeners = new Set<() => void>();
  closed = false;

  constructor(
    private readonly port: chrome.runtime.Port,
    readonly tabId: number,
    readonly documentId: string,
  ) {
    port.onMessage.addListener((raw: unknown) => {
      const message = parseContentMessage(raw);
      if (!message) return; // 형식이 맞지 않는 메시지는 버린다.
      const waiting = this.pending.get(message.reqId);
      if (waiting && message.kind !== 'pick-started') {
        this.pending.delete(message.reqId);
        if (waiting.timer) clearTimeout(waiting.timer);
        waiting.resolve(message);
      }
      for (const listener of this.listeners) listener(message);
    });
    port.onDisconnect.addListener(() => {
      // lastError를 읽어 콘솔 경고를 막는다.
      void chrome.runtime.lastError;
      this.closed = true;
      for (const [, waiting] of this.pending) {
        if (waiting.timer) clearTimeout(waiting.timer);
        waiting.reject(new PageGoneError());
      }
      this.pending.clear();
      for (const listener of this.closeListeners) listener();
    });
  }

  post(message: PanelToContent) {
    if (this.closed) throw new PageGoneError();
    this.port.postMessage(message);
  }

  /** reqId가 같은 응답을 기다린다. timeoutMs가 null이면 무기한 */
  request(message: PanelToContent & { reqId: string }, timeoutMs: number | null = 5000): Promise<ContentToPanel> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new PageGoneError());
        return;
      }
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(message.reqId);
              reject(new Error('페이지가 응답하지 않습니다.'));
            }, timeoutMs);
      this.pending.set(message.reqId, { resolve, reject, timer });
      try {
        this.port.postMessage(message);
      } catch {
        this.pending.delete(message.reqId);
        if (timer) clearTimeout(timer);
        reject(new PageGoneError());
      }
    });
  }

  cancelWait(reqId: string) {
    const waiting = this.pending.get(reqId);
    if (!waiting) return;
    this.pending.delete(reqId);
    if (waiting.timer) clearTimeout(waiting.timer);
  }

  onMessage(listener: (message: ContentToPanel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  disconnect() {
    if (this.closed) return;
    this.port.disconnect();
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
}

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
  'chrome-search://',
];
const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (RESTRICTED_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'chrome.google.com' && !parsed.pathname.startsWith('/webstore')) return false;
    return RESTRICTED_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

function classifyInjectError(error: unknown): Error {
  const message = String((error as Error)?.message ?? error);
  if (/Cannot access contents of|must request permission|Missing host permission/i.test(message)) return new NoAccessError();
  if (/cannot be scripted|chrome:\/\/|extensions gallery|Cannot access a chrome/i.test(message)) return new RestrictedPageError();
  if (/No tab with id|was removed|error page/i.test(message)) return new PageGoneError(message);
  return new Error(message);
}

export class ContentBridge {
  private readonly sessions = new Map<string, PortSession>();

  /** content script를 주입하고 문서 id를 돌려준다(이미 있으면 다시 쓰지 않고 연결만 확인) */
  async inject(tabId: number): Promise<string> {
    let results: chrome.scripting.InjectionResult[];
    try {
      results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    } catch (error) {
      throw classifyInjectError(error);
    }
    const documentId = results[0]?.documentId;
    if (!documentId) throw new Error('문서 id를 받지 못했습니다.');
    return documentId;
  }

  session(tabId: number, documentId: string): PortSession {
    const existing = this.sessions.get(documentId);
    if (existing && !existing.closed) return existing;
    const port = chrome.tabs.connect(tabId, { name: PORT_NAME, documentId });
    const session = new PortSession(port, tabId, documentId);
    this.sessions.set(documentId, session);
    session.onClose(() => {
      if (this.sessions.get(documentId) === session) this.sessions.delete(documentId);
    });
    return session;
  }

  /** 주입 후 연결 */
  async open(tabId: number): Promise<PortSession> {
    const documentId = await this.inject(tabId);
    return this.session(tabId, documentId);
  }

  /**
   * 이미 수집한 문서에 다시 연결. 문서가 사라졌으면 PageGoneError.
   * 이동한 문서가 뒤로 가기 캐시(BFCache)에 있으면 포트가 바로 끊기지 않고 응답만 없으므로 짧게 기다린다.
   */
  async reconnect(tabId: number, documentId: string, timeoutMs = 1500): Promise<PortSession> {
    let session: PortSession;
    try {
      session = this.session(tabId, documentId);
    } catch {
      throw new PageGoneError();
    }
    const reqId = makeId('r');
    try {
      const reply = await session.request({ kind: 'element-status', reqId, snapshotId: 'probe', elementId: 'E1' }, timeoutMs);
      if (reply.kind !== 'element-status-result') throw new PageGoneError();
    } catch {
      session.disconnect();
      throw new PageGoneError();
    }
    return session;
  }

  closeAll() {
    for (const session of this.sessions.values()) session.disconnect();
    this.sessions.clear();
  }
}
