/**
 * NoodleLens content script.
 *
 * 사용자가 패널에서 '요소 선택'을 누를 때만 chrome.scripting.executeScript로 주입된다.
 * 패널이 chrome.tabs.connect로 연 포트를 통해서만 명령을 받고,
 * 포트가 끊기면(패널 닫힘) 선택 모드와 강조를 정리한다.
 * API 키나 대화 내용은 이 스크립트로 오지 않는다.
 */
import { collectSnapshot } from './collect';
import { Overlay } from './overlay';
import { Picker } from './picker';
import { Tracker } from './tracker';
import { makeId } from '../shared/ids';
import {
  PORT_NAME,
  parsePanelMessage,
  type ContentToPanel,
  type ElementStatus,
  type PanelToContent,
  type PickCancelReason,
} from '../shared/protocol';
import { DEFAULT_LIMITS } from '../shared/snapshot';

const INSTANCE_KEY = '__noodleLensContent';
const MAX_KEPT_SNAPSHOTS = 20;
const SELECTED_FLASH_MS = 2500;
const EVIDENCE_FLASH_MS = 3500;

interface ContentApp {
  alive(): boolean;
  destroy(): void;
}

type Port = chrome.runtime.Port;

function contextAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function createApp(): ContentApp {
  const ports = new Set<Port>();
  /** snapshotId → (elementId → 요소). 페이지 DOM에는 아무것도 표시하지 않는다 */
  const snapshots = new Map<string, Map<string, WeakRef<Element>>>();
  let overlay: Overlay | null = null;
  let tracker: Tracker | null = null;
  let picker: Picker | null = null;
  let pickOwner: { port: Port; reqId: string } | null = null;

  const ensureOverlay = () => {
    if (!overlay) {
      overlay = new Overlay();
      tracker = new Tracker(overlay);
    }
    return { overlay, tracker: tracker! };
  };

  const isOwnNode = (node: Node) => Boolean(overlay?.isOwn(node));

  const post = (port: Port, message: ContentToPanel) => {
    try {
      port.postMessage(message);
    } catch {
      // 패널이 이미 닫혔다.
    }
  };

  const remember = (snapshotId: string, refs: Map<string, Element>) => {
    const weak = new Map<string, WeakRef<Element>>();
    for (const [id, el] of refs) weak.set(id, new WeakRef(el));
    snapshots.set(snapshotId, weak);
    while (snapshots.size > MAX_KEPT_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
  };

  const lookup = (snapshotId: string, elementId: string): { status: ElementStatus; el?: Element } => {
    const refs = snapshots.get(snapshotId);
    const ref = refs?.get(elementId);
    if (!refs || !ref) return { status: 'unknown' };
    const el = ref.deref();
    if (!el || !el.isConnected) return { status: 'detached' };
    return { status: 'connected', el };
  };

  const endPick = (reason: PickCancelReason | null) => {
    const owner = pickOwner;
    pickOwner = null;
    picker?.stop();
    if (owner && reason) post(owner.port, { kind: 'pick-cancelled', reqId: owner.reqId, reason });
  };

  const startPick = (port: Port, reqId: string, idOffset: number) => {
    if (pickOwner) endPick('replaced');
    const { overlay: ov, tracker: tr } = ensureOverlay();
    pickOwner = { port, reqId };
    picker = new Picker(ov, tr, {
      onPick: (el) => {
        const owner = pickOwner;
        pickOwner = null;
        if (!owner) return;
        try {
          const snapshotId = makeId('s');
          const { snapshot, refs } = collectSnapshot(el, { snapshotId, idOffset, limits: DEFAULT_LIMITS, isOwnNode });
          remember(snapshotId, refs);
          tr.follow(el, 'selected', SELECTED_FLASH_MS);
          post(owner.port, { kind: 'picked', reqId: owner.reqId, snapshot });
        } catch (error) {
          post(owner.port, { kind: 'error', reqId: owner.reqId, message: `수집 실패: ${String(error).slice(0, 200)}` });
        }
      },
      onCancel: (reason) => {
        const owner = pickOwner;
        pickOwner = null;
        if (owner) post(owner.port, { kind: 'pick-cancelled', reqId: owner.reqId, reason });
      },
    });
    picker.start();
    post(port, { kind: 'pick-started', reqId });
  };

  const handle = (port: Port, message: PanelToContent) => {
    switch (message.kind) {
      case 'pick-start':
        startPick(port, message.reqId, message.idOffset);
        break;
      case 'pick-cancel':
        if (pickOwner?.reqId === message.reqId) endPick('panel-request');
        break;
      case 'recollect': {
        const found = lookup(message.snapshotId, message.elementId);
        if (!found.el) {
          post(port, { kind: 'element-status-result', reqId: message.reqId, status: found.status });
          break;
        }
        try {
          const snapshotId = makeId('s');
          const { snapshot, refs } = collectSnapshot(found.el, {
            snapshotId,
            idOffset: message.idOffset,
            limits: DEFAULT_LIMITS,
            isOwnNode,
          });
          remember(snapshotId, refs);
          ensureOverlay().tracker.follow(found.el, 'selected', SELECTED_FLASH_MS);
          post(port, { kind: 'recollected', reqId: message.reqId, snapshot });
        } catch (error) {
          post(port, { kind: 'error', reqId: message.reqId, message: `수집 실패: ${String(error).slice(0, 200)}` });
        }
        break;
      }
      case 'highlight': {
        const found = lookup(message.snapshotId, message.elementId);
        if (found.el) {
          const r = found.el.getBoundingClientRect();
          const offscreen = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
          if (message.scroll && offscreen) found.el.scrollIntoView({ block: 'center', inline: 'nearest' });
          ensureOverlay().tracker.follow(found.el, 'evidence', EVIDENCE_FLASH_MS);
        }
        post(port, { kind: 'highlight-result', reqId: message.reqId, status: found.status });
        break;
      }
      case 'element-status':
        post(port, {
          kind: 'element-status-result',
          reqId: message.reqId,
          status: lookup(message.snapshotId, message.elementId).status,
        });
        break;
      case 'clear-highlight':
        if (!picker?.isActive) tracker?.stop();
        break;
    }
  };

  const onConnect = (port: Port) => {
    if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) return;
    ports.add(port);
    port.onMessage.addListener((raw: unknown) => {
      const message = parsePanelMessage(raw);
      if (message) handle(port, message);
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (pickOwner?.port === port) endPick(null);
      if (ports.size === 0) tracker?.stop();
    });
  };

  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) endPick('pagehide');
  };

  chrome.runtime.onConnect.addListener(onConnect);
  window.addEventListener('pagehide', onPageHide);

  return {
    alive: contextAlive,
    destroy() {
      endPick(null);
      tracker?.stop();
      overlay?.destroy();
      overlay = null;
      tracker = null;
      try {
        chrome.runtime.onConnect.removeListener(onConnect);
      } catch {
        // 확장 프로그램이 다시 로드되어 이전 컨텍스트가 무효다.
      }
      window.removeEventListener('pagehide', onPageHide);
      for (const port of ports) {
        try {
          port.disconnect();
        } catch {
          // 무시
        }
      }
      ports.clear();
    },
  };
}

function boot() {
  const scope = window as unknown as Record<string, ContentApp | undefined>;
  const existing = scope[INSTANCE_KEY];
  if (existing) {
    if (existing.alive()) return;
    existing.destroy();
  }
  scope[INSTANCE_KEY] = createApp();
}

boot();
