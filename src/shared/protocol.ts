/**
 * 사이드 패널 ↔ content script 메시지 형식과 검증.
 *
 * 패널은 chrome.tabs.connect로 특정 문서(documentId)에 포트를 연다.
 * 포트가 끊기면 페이지 이동·탭 닫힘·패널 닫힘을 뜻하므로 양쪽 모두 정리한다.
 * content script는 페이지 렌더러에서 돌기 때문에, 패널은 받은 메시지를 신뢰하지 않고 검증한다.
 */
import {
  SNAPSHOT_SCHEMA_VERSION,
  type ElementSnapshot,
  type Limitation,
  type Snapshot,
  type TextInfo,
} from './snapshot';
import { ALLOWED_ATTRIBUTES, ALLOWED_PSEUDO_KEYS, ALLOWED_STYLE_KEYS } from './styleProps';

export const PORT_NAME = 'noodlelens/v1';

export type PickCancelReason = 'escape' | 'replaced' | 'tab-hidden' | 'panel-request' | 'pagehide';

export type PanelToContent =
  | { kind: 'pick-start'; reqId: string; idOffset: number }
  | { kind: 'pick-cancel'; reqId: string }
  | { kind: 'recollect'; reqId: string; snapshotId: string; elementId: string; idOffset: number }
  | { kind: 'highlight'; reqId: string; snapshotId: string; elementId: string; scroll: boolean }
  | { kind: 'element-status'; reqId: string; snapshotId: string; elementId: string }
  | { kind: 'clear-highlight' };

export type ElementStatus = 'connected' | 'detached' | 'unknown';

export type ContentToPanel =
  | { kind: 'pick-started'; reqId: string }
  | { kind: 'picked'; reqId: string; snapshot: Snapshot }
  | { kind: 'pick-cancelled'; reqId: string; reason: PickCancelReason }
  | { kind: 'recollected'; reqId: string; snapshot: Snapshot }
  | { kind: 'highlight-result'; reqId: string; status: ElementStatus }
  | { kind: 'element-status-result'; reqId: string; status: ElementStatus }
  | { kind: 'error'; reqId: string; message: string };

const REQ_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ELEMENT_ID = /^E\d{1,5}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 대화당 요소 번호 상한. 이보다 크면 다시 시작하도록 안내한다 */
export const MAX_ELEMENT_NUMBER = 99_999;
/** 스냅샷 하나에 들어갈 수 있는 요소 수 상한(검증용) */
export const MAX_ELEMENTS_PER_SNAPSHOT = 60;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStr(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isStringRecord(value: unknown, allowed: ReadonlySet<string> | null, maxValue: number, maxKeys: number) {
  if (!isObj(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > maxKeys) return false;
  return keys.every((key) => (allowed ? allowed.has(key) : key.length <= 64) && isStr(value[key], maxValue));
}

export function parsePanelMessage(value: unknown): PanelToContent | null {
  if (!isObj(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'pick-start':
      return REQ_ID.test(String(value.reqId)) && isInt(value.idOffset, 0, MAX_ELEMENT_NUMBER)
        ? { kind: 'pick-start', reqId: String(value.reqId), idOffset: value.idOffset as number }
        : null;
    case 'pick-cancel':
      return REQ_ID.test(String(value.reqId)) ? { kind: 'pick-cancel', reqId: String(value.reqId) } : null;
    case 'recollect':
      return REQ_ID.test(String(value.reqId)) &&
        SNAPSHOT_ID.test(String(value.snapshotId)) &&
        ELEMENT_ID.test(String(value.elementId)) &&
        isInt(value.idOffset, 0, MAX_ELEMENT_NUMBER)
        ? {
            kind: 'recollect',
            reqId: String(value.reqId),
            snapshotId: String(value.snapshotId),
            elementId: String(value.elementId),
            idOffset: value.idOffset as number,
          }
        : null;
    case 'highlight':
      return REQ_ID.test(String(value.reqId)) &&
        SNAPSHOT_ID.test(String(value.snapshotId)) &&
        ELEMENT_ID.test(String(value.elementId)) &&
        isBool(value.scroll)
        ? {
            kind: 'highlight',
            reqId: String(value.reqId),
            snapshotId: String(value.snapshotId),
            elementId: String(value.elementId),
            scroll: value.scroll,
          }
        : null;
    case 'element-status':
      return REQ_ID.test(String(value.reqId)) &&
        SNAPSHOT_ID.test(String(value.snapshotId)) &&
        ELEMENT_ID.test(String(value.elementId))
        ? {
            kind: 'element-status',
            reqId: String(value.reqId),
            snapshotId: String(value.snapshotId),
            elementId: String(value.elementId),
          }
        : null;
    case 'clear-highlight':
      return { kind: 'clear-highlight' };
    default:
      return null;
  }
}

const RECT_KEYS = ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'] as const;
const BOX_KEYS = ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollLeft', 'scrollTop', 'clientLeft', 'clientTop'] as const;
const ROLES = new Set(['target', 'ancestor', 'child', 'sibling', 'offender']);
const LIMITATION_CODES = new Set([
  'closed-shadow-root',
  'inside-open-shadow-root',
  'iframe-not-inspected',
  'svg-element',
  'not-rendered',
  'scan-truncated',
  'pseudo-only',
  'text-excluded',
]);
const EXCLUDED_REASONS = new Set(['form-control', 'contenteditable', 'password', 'user-excluded']);
const FLAG_KEYS = new Set([
  'inShadowRoot',
  'shadowHost',
  'iframe',
  'iframeInaccessible',
  'svg',
  'replaced',
  'formControl',
  'contentEditable',
  'notRendered',
]);

function validText(value: unknown): value is TextInfo {
  if (!isObj(value)) return false;
  if (value.kind === 'none') return true;
  if (value.kind === 'excluded') return EXCLUDED_REASONS.has(String(value.reason));
  if (value.kind === 'text') return isStr(value.value, 2000) && isBool(value.truncated);
  return false;
}

function validElement(value: unknown): value is ElementSnapshot {
  if (!isObj(value)) return false;
  if (!ELEMENT_ID.test(String(value.id)) || !ROLES.has(String(value.role))) return false;
  if (value.detail !== 'full' && value.detail !== 'compact') return false;
  if (value.depth !== undefined && !isInt(value.depth, 1, 10_000)) return false;
  if (value.alsoRoles !== undefined) {
    if (!Array.isArray(value.alsoRoles) || value.alsoRoles.length > 4) return false;
    if (!value.alsoRoles.every((role) => ROLES.has(String(role)))) return false;
  }
  if (!isStr(value.tag, 64) || !/^[a-z][a-z0-9-]*$/.test(value.tag)) return false;
  if (!isStr(value.label, 300)) return false;
  if (!isStringRecord(value.attributes, ALLOWED_ATTRIBUTES, 400, 40)) return false;
  if (!isInt(value.omittedAttributeCount, 0, 100_000) || !isInt(value.classOmittedCount, 0, 100_000)) return false;
  if (!validText(value.text)) return false;
  if (!isObj(value.rect) || !RECT_KEYS.every((key) => isNum((value.rect as Obj)[key]))) return false;
  if (!isObj(value.box) || !BOX_KEYS.every((key) => isNum((value.box as Obj)[key]))) return false;
  const box = value.box as Obj;
  if (!(box.offsetWidth === null || isNum(box.offsetWidth)) || !(box.offsetHeight === null || isNum(box.offsetHeight))) {
    return false;
  }
  if (!isStringRecord(value.styles, ALLOWED_STYLE_KEYS, 300, 120)) return false;
  if (value.pseudo !== undefined) {
    if (!isObj(value.pseudo)) return false;
    for (const key of Object.keys(value.pseudo)) {
      if (key !== 'before' && key !== 'after') return false;
      if (!isStringRecord(value.pseudo[key], ALLOWED_PSEUDO_KEYS, 120, 10)) return false;
    }
  }
  if (!isInt(value.childElementCount, 0, 10_000_000)) return false;
  if (!isObj(value.flags)) return false;
  for (const [key, flag] of Object.entries(value.flags)) {
    if (!FLAG_KEYS.has(key)) return false;
    if (key === 'shadowHost' ? flag !== 'open' && flag !== 'closed' : !isBool(flag)) return false;
  }
  if (value.image !== undefined) {
    const image = value.image;
    if (
      !isObj(image) ||
      !isNum(image.naturalWidth) ||
      !isNum(image.naturalHeight) ||
      !isBool(image.complete) ||
      !isBool(image.hasWidthAttr) ||
      !isBool(image.hasHeightAttr) ||
      !isStr(image.src, 400)
    ) {
      return false;
    }
  }
  if (value.indexInParent !== undefined && !isInt(value.indexInParent, 1, 10_000_000)) return false;
  if (value.offenderOf !== undefined && value.offenderOf !== 'page' && value.offenderOf !== 'target') return false;
  if (value.overflowPx !== undefined && !isNum(value.overflowPx)) return false;
  return true;
}

function validLimitation(value: unknown): value is Limitation {
  return (
    isObj(value) &&
    LIMITATION_CODES.has(String(value.code)) &&
    isStr(value.message, 300) &&
    (value.elementId === undefined || ELEMENT_ID.test(String(value.elementId)))
  );
}

export function validateSnapshot(value: unknown): Snapshot | null {
  if (!isObj(value)) return null;
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
  if (!SNAPSHOT_ID.test(String(value.id)) || !ELEMENT_ID.test(String(value.targetId))) return null;
  const page = value.page;
  if (!isObj(page)) return null;
  if (!isStr(page.url, 400) || !isBool(page.urlRedacted) || !isStr(page.title, 300) || !isStr(page.collectedAt, 40)) {
    return null;
  }
  if (Number.isNaN(Date.parse(page.collectedAt))) return null;
  const viewport = page.viewport;
  const scroll = page.scroll;
  const doc = page.document;
  if (!isObj(viewport) || !['innerWidth', 'innerHeight', 'clientWidth', 'clientHeight', 'dpr'].every((k) => isNum(viewport[k]))) {
    return null;
  }
  if (!isObj(scroll) || !isNum(scroll.x) || !isNum(scroll.y)) return null;
  if (
    !isObj(doc) ||
    !['scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'].every((k) => isNum(doc[k])) ||
    !isBool(doc.hasHorizontalOverflow) ||
    !isBool(doc.hasVerticalOverflow) ||
    !isStr(doc.compatMode, 32)
  ) {
    return null;
  }
  if (!Array.isArray(value.elements) || value.elements.length === 0 || value.elements.length > MAX_ELEMENTS_PER_SNAPSHOT) {
    return null;
  }
  if (!value.elements.every(validElement)) return null;
  const ids = new Set(value.elements.map((el) => (el as ElementSnapshot).id));
  if (ids.size !== value.elements.length || !ids.has(String(value.targetId))) return null;
  const targets = value.elements.filter((el) => (el as ElementSnapshot).role === 'target');
  if (targets.length !== 1 || (targets[0] as ElementSnapshot).id !== value.targetId) return null;
  if (!isObj(value.limits) || !Object.values(value.limits).every((v) => isInt(v, 0, 1_000_000))) return null;
  const omitted = value.omitted;
  if (!isObj(omitted) || !['ancestors', 'children', 'siblings', 'offenders', 'scanSkipped'].every((k) => isInt(omitted[k], 0, 10_000_000))) {
    return null;
  }
  if (!Array.isArray(value.limitations) || value.limitations.length > 40 || !value.limitations.every(validLimitation)) {
    return null;
  }
  for (const limitation of value.limitations as Limitation[]) {
    if (limitation.elementId && !ids.has(limitation.elementId)) return null;
  }
  return value as unknown as Snapshot;
}

export function parseContentMessage(value: unknown): ContentToPanel | null {
  if (!isObj(value) || typeof value.kind !== 'string' || !REQ_ID.test(String(value.reqId))) return null;
  const reqId = String(value.reqId);
  switch (value.kind) {
    case 'pick-started':
      return { kind: 'pick-started', reqId };
    case 'picked':
    case 'recollected': {
      const snapshot = validateSnapshot(value.snapshot);
      return snapshot ? { kind: value.kind, reqId, snapshot } : null;
    }
    case 'pick-cancelled': {
      const reason = String(value.reason);
      return ['escape', 'replaced', 'tab-hidden', 'panel-request', 'pagehide'].includes(reason)
        ? { kind: 'pick-cancelled', reqId, reason: reason as PickCancelReason }
        : null;
    }
    case 'highlight-result':
    case 'element-status-result': {
      const status = String(value.status);
      return status === 'connected' || status === 'detached' || status === 'unknown'
        ? { kind: value.kind, reqId, status }
        : null;
    }
    case 'error':
      return isStr(value.message, 500) ? { kind: 'error', reqId, message: value.message } : null;
    default:
      return null;
  }
}
