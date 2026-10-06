/**
 * 요소 스냅샷 데이터 모델.
 *
 * content script가 선택 시점의 DOM·스타일·크기를 이 형태로 수집하고,
 * 패널은 검증을 거쳐 저장하고 모델에 보낼 텍스트로 바꾼다.
 * 페이지에서 온 문자열은 모두 신뢰할 수 없는 데이터다.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1;

export type ElementRole = 'target' | 'ancestor' | 'child' | 'sibling' | 'offender';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BoxMetrics {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  offsetWidth: number | null;
  offsetHeight: number | null;
  scrollLeft: number;
  scrollTop: number;
  /** 왼쪽·위쪽 테두리 두께(clientLeft/clientTop) */
  clientLeft: number;
  clientTop: number;
}

export type TextInfo =
  | { kind: 'text'; value: string; truncated: boolean }
  | { kind: 'excluded'; reason: 'form-control' | 'contenteditable' | 'password' | 'user-excluded' }
  | { kind: 'none' };

export interface ImageInfo {
  naturalWidth: number;
  naturalHeight: number;
  complete: boolean;
  hasWidthAttr: boolean;
  hasHeightAttr: boolean;
  /** 경로만 남긴 currentSrc. data: URL 등은 생략 표시 */
  src: string;
}

export interface ElementFlags {
  /** open shadow root 안에 있는 요소 */
  inShadowRoot?: boolean;
  /** 이 요소가 shadow host인 경우 종류 */
  shadowHost?: 'open' | 'closed';
  iframe?: boolean;
  /** cross-origin 등으로 iframe 문서에 접근할 수 없음 */
  iframeInaccessible?: boolean;
  svg?: boolean;
  replaced?: boolean;
  formControl?: boolean;
  contentEditable?: boolean;
  /** display:none 등으로 렌더링 박스가 없음 */
  notRendered?: boolean;
}

export interface ElementSnapshot {
  /** 대화 안에서 유일한 식별자. 모델은 이 값만 인용할 수 있다. 예: E3 */
  id: string;
  role: ElementRole;
  /** ancestor면 대상에서 몇 단계 위인지(1 = 부모) */
  depth?: number;
  /** 같은 요소가 다른 역할로도 수집되었을 때 */
  alsoRoles?: ElementRole[];
  tag: string;
  /** 예: div#main.card.card--wide */
  label: string;
  attributes: Record<string, string>;
  omittedAttributeCount: number;
  classOmittedCount: number;
  text: TextInfo;
  rect: Rect;
  box: BoxMetrics;
  styles: Record<string, string>;
  pseudo?: { before?: Record<string, string>; after?: Record<string, string> };
  childElementCount: number;
  flags: ElementFlags;
  image?: ImageInfo;
  /** 부모 기준 몇 번째 자식인지(1부터). 같은 태그 형제 구분용 */
  indexInParent?: number;
  /** offender일 때: 페이지 가로 넘침 후보인지, 대상 요소 내부 넘침 후보인지 */
  offenderOf?: 'page' | 'target';
  /** offender일 때: 넘친 거리(px) */
  overflowPx?: number;
  /** 수집 상세도. full은 대상·부모, compact는 나머지 */
  detail: 'full' | 'compact';
}

export interface PageInfo {
  /** origin + pathname, 쿼리 값은 지운다 */
  url: string;
  urlRedacted: boolean;
  title: string;
  collectedAt: string;
  viewport: { innerWidth: number; innerHeight: number; clientWidth: number; clientHeight: number; dpr: number };
  scroll: { x: number; y: number };
  document: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    hasHorizontalOverflow: boolean;
    hasVerticalOverflow: boolean;
    compatMode: string;
  };
}

export interface CollectionLimits {
  maxAncestors: number;
  maxChildren: number;
  maxSiblings: number;
  maxOffenders: number;
  maxTextChars: number;
  maxCompactTextChars: number;
  maxAttributeChars: number;
  maxClasses: number;
  maxScanElements: number;
}

export const DEFAULT_LIMITS: CollectionLimits = {
  maxAncestors: 6,
  maxChildren: 8,
  maxSiblings: 4,
  maxOffenders: 5,
  maxTextChars: 300,
  maxCompactTextChars: 80,
  maxAttributeChars: 200,
  maxClasses: 8,
  maxScanElements: 5000,
};

export interface OmittedCounts {
  ancestors: number;
  children: number;
  siblings: number;
  offenders: number;
  /** 넘침 원인 후보를 찾다가 상한에 걸려 검사하지 못한 요소 수 */
  scanSkipped: number;
}

/** 수집하지 못했거나 지원하지 않는 부분. 모델과 사용자 모두에게 보여 준다. */
export interface Limitation {
  code:
    | 'closed-shadow-root'
    | 'inside-open-shadow-root'
    | 'iframe-not-inspected'
    | 'svg-element'
    | 'not-rendered'
    | 'scan-truncated'
    | 'pseudo-only'
    | 'text-excluded';
  message: string;
  elementId?: string;
}

export interface SnapshotSource {
  tabId: number;
  frameId: number;
  documentId?: string;
}

export interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  id: string;
  page: PageInfo;
  targetId: string;
  elements: ElementSnapshot[];
  limits: CollectionLimits;
  omitted: OmittedCounts;
  limitations: Limitation[];
}

/** 패널이 저장할 때 붙이는 정보(모델에는 보내지 않음) */
export interface StoredSnapshot extends Snapshot {
  conversationId: string;
  source: SnapshotSource;
  /** 사용자가 전송에서 제외한 항목 */
  exclusions: SnapshotExclusions;
  savedAt: number;
}

export interface SnapshotExclusions {
  /** 제외한 요소 id. 대상 요소는 제외할 수 없다 */
  elementIds: string[];
  text: boolean;
  attributes: boolean;
  pageUrl: boolean;
  pageTitle: boolean;
}

export const NO_EXCLUSIONS: SnapshotExclusions = {
  elementIds: [],
  text: false,
  attributes: false,
  pageUrl: false,
  pageTitle: false,
};

export function getTarget(snapshot: Snapshot): ElementSnapshot {
  const target = snapshot.elements.find((el) => el.id === snapshot.targetId);
  if (!target) throw new Error('snapshot has no target element');
  return target;
}

export function getParent(snapshot: Snapshot): ElementSnapshot | undefined {
  return snapshot.elements.find((el) => el.role === 'ancestor' && el.depth === 1);
}

export function getAncestors(snapshot: Snapshot): ElementSnapshot[] {
  return snapshot.elements
    .filter((el) => el.role === 'ancestor')
    .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
}

export function elementIdNumber(id: string): number {
  const match = /^E(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.NaN;
}
