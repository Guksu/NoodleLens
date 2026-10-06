import {
  SNAPSHOT_SCHEMA_VERSION,
  type BoxMetrics,
  type CollectionLimits,
  type ElementFlags,
  type ElementRole,
  type ElementSnapshot,
  type ImageInfo,
  type Limitation,
  type PageInfo,
  type Rect,
  type Snapshot,
  type TextInfo,
} from '../shared/snapshot';
import {
  ALLOWED_ATTRIBUTES,
  ALWAYS_PROPS,
  BOX_SHORTHANDS,
  FLEX_CONTAINER_PROPS,
  FLEX_ITEM_PROPS,
  GRID_CONTAINER_PROPS,
  GRID_ITEM_PROPS,
  LINE_CLAMP_PROPS,
  NON_DEFAULT_PROPS,
  POSITIONED_PROPS,
  PSEUDO_PROPS,
  TEXT_PROPS,
  isFlexDisplay,
  isGridDisplay,
} from '../shared/styleProps';
import { clip, collapseWhitespace, sanitizeUrl, truncate } from '../shared/text';

export interface CollectOptions {
  snapshotId: string;
  /** 이 대화에서 이미 쓴 마지막 요소 번호. 새 요소는 E{idOffset+1}부터 */
  idOffset: number;
  limits: CollectionLimits;
  /** 확장 프로그램이 추가한 노드인지 */
  isOwnNode: (node: Node) => boolean;
}

export interface CollectResult {
  snapshot: Snapshot;
  refs: Map<string, Element>;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
const FORM_CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'DATALIST']);
const REPLACED_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'AUDIO']);
const MAX_TARGET_SCAN = 1500;
const MAX_TARGET_OFFENDERS = 3;

interface Entry {
  el: Element;
  role: ElementRole;
  detail: 'full' | 'compact';
  depth?: number;
  alsoRoles?: ElementRole[];
  offenderOf?: 'page' | 'target';
  overflowPx?: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const parent = el.parentNode;
  if (parent instanceof ShadowRoot) return parent.host;
  return null;
}

function isCollectable(el: Element, isOwnNode: (node: Node) => boolean): boolean {
  return !SKIP_TAGS.has(el.tagName) && !isOwnNode(el);
}

function renderedChildren(el: Element, isOwnNode: (node: Node) => boolean): Element[] {
  const source = el.shadowRoot ? el.shadowRoot.children : el.children;
  return Array.from(source).filter((child) => isCollectable(child, isOwnNode));
}

function siblingsNearestFirst(target: Element, isOwnNode: (node: Node) => boolean): Element[] {
  const parent = target.parentNode;
  if (!parent || !('children' in parent)) return [];
  const all = Array.from((parent as ParentNode).children).filter((el) => isCollectable(el, isOwnNode));
  const index = all.indexOf(target);
  if (index < 0) return all.filter((el) => el !== target);
  const ordered: Element[] = [];
  for (let distance = 1; ordered.length < all.length - 1; distance += 1) {
    const before = all[index - distance];
    const after = all[index + distance];
    if (!before && !after) break;
    if (before) ordered.push(before);
    if (after) ordered.push(after);
  }
  return ordered;
}

function labelOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${clip(el.id, 40)}` : '';
  const classes = Array.from(el.classList)
    .slice(0, 3)
    .map((name) => `.${clip(name, 32)}`)
    .join('');
  const more = el.classList.length > 3 ? '…' : '';
  return `${tag}${id}${classes}${more}`;
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: round(r.x),
    y: round(r.y),
    width: round(r.width),
    height: round(r.height),
    top: round(r.top),
    right: round(r.right),
    bottom: round(r.bottom),
    left: round(r.left),
  };
}

function boxOf(el: Element): BoxMetrics {
  const html = el as HTMLElement;
  return {
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    offsetWidth: typeof html.offsetWidth === 'number' ? html.offsetWidth : null,
    offsetHeight: typeof html.offsetHeight === 'number' ? html.offsetHeight : null,
    scrollLeft: round(el.scrollLeft),
    scrollTop: round(el.scrollTop),
    clientLeft: el.clientLeft,
    clientTop: el.clientTop,
  };
}

function compressBox(values: string[]): string {
  const [t, r, b, l] = values.map((v) => v.trim());
  if (t === r && r === b && b === l) return t ?? '';
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue && node.nodeValue.trim() !== '') return true;
  }
  return false;
}

function pickStyles(
  cs: CSSStyleDeclaration,
  parentDisplay: string | undefined,
  detail: 'full' | 'compact',
  directText: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (prop: string) => {
    const value = cs.getPropertyValue(prop).trim();
    if (value !== '') out[prop] = clip(value, 200);
  };
  ALWAYS_PROPS.forEach(add);
  for (const [name, longhands] of Object.entries(BOX_SHORTHANDS)) {
    out[name] = clip(compressBox(longhands.map((prop) => cs.getPropertyValue(prop))), 120);
  }
  const display = cs.getPropertyValue('display');
  if (isFlexDisplay(display)) FLEX_CONTAINER_PROPS.forEach(add);
  if (isGridDisplay(display)) GRID_CONTAINER_PROPS.forEach(add);
  if (isFlexDisplay(parentDisplay)) FLEX_ITEM_PROPS.forEach(add);
  if (isGridDisplay(parentDisplay)) GRID_ITEM_PROPS.forEach(add);
  if (cs.getPropertyValue('position') !== 'static') POSITIONED_PROPS.forEach(add);
  const textOverflow = cs.getPropertyValue('text-overflow');
  const whiteSpace = cs.getPropertyValue('white-space');
  if (detail === 'full' || directText || textOverflow !== 'clip' || whiteSpace !== 'normal') {
    TEXT_PROPS.forEach(add);
  }
  const clamp = cs.getPropertyValue('-webkit-line-clamp').trim();
  if ((clamp !== '' && clamp !== 'none') || display === '-webkit-box' || display === '-webkit-inline-box') {
    LINE_CLAMP_PROPS.forEach(add);
  }
  for (const [prop, defaults] of Object.entries(NON_DEFAULT_PROPS)) {
    if (prop in out) continue;
    const value = cs.getPropertyValue(prop).trim();
    if (value !== '' && !defaults.includes(value)) out[prop] = clip(value, 200);
  }
  return out;
}

function pseudoStyles(el: Element, which: '::before' | '::after'): Record<string, string> | undefined {
  const cs = getComputedStyle(el, which);
  const content = cs.getPropertyValue('content').trim();
  if (content === '' || content === 'none' || content === 'normal') return undefined;
  const out: Record<string, string> = {};
  for (const prop of PSEUDO_PROPS) {
    const value = cs.getPropertyValue(prop).trim();
    if (value !== '') out[prop] = clip(value, 80);
  }
  return out;
}

function attributesOf(el: Element, limits: CollectionLimits) {
  const attributes: Record<string, string> = {};
  let omitted = 0;
  let classOmitted = 0;
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_ATTRIBUTES.has(name)) {
      omitted += 1;
      continue;
    }
    if (name === 'class') {
      const names = collapseWhitespace(attr.value).split(' ').filter(Boolean);
      classOmitted = Math.max(0, names.length - limits.maxClasses);
      attributes.class = names
        .slice(0, limits.maxClasses)
        .map((value) => clip(value, 40))
        .join(' ');
    } else if (name === 'href' || name === 'src') {
      attributes[name] = sanitizeUrl(attr.value, document.baseURI).url;
    } else if (name === 'style') {
      attributes.style = clip(collapseWhitespace(attr.value), limits.maxAttributeChars);
    } else {
      attributes[name] = clip(collapseWhitespace(attr.value), 80);
    }
  }
  return { attributes, omitted, classOmitted };
}

function isPasswordInput(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === 'password';
}

export function collectText(el: Element, max: number, isOwnNode: (node: Node) => boolean): TextInfo {
  if (isPasswordInput(el)) return { kind: 'excluded', reason: 'password' };
  if (FORM_CONTROL_TAGS.has(el.tagName)) return { kind: 'excluded', reason: 'form-control' };
  if (el instanceof HTMLElement && el.isContentEditable) return { kind: 'excluded', reason: 'contenteditable' };
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const child = node as Element;
        if (
          SKIP_TAGS.has(child.tagName) ||
          FORM_CONTROL_TAGS.has(child.tagName) ||
          isOwnNode(child) ||
          (child instanceof HTMLElement && child.isContentEditable)
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let raw = '';
  let cut = false;
  while (walker.nextNode()) {
    raw += walker.currentNode.nodeValue ?? '';
    // 공백이 많은 문서를 대비해 넉넉히 읽고 멈춘다.
    if (raw.length > max * 4 + 200) {
      cut = true;
      break;
    }
  }
  const collapsed = collapseWhitespace(raw);
  if (collapsed === '') return { kind: 'none' };
  const result = truncate(collapsed, max);
  return { kind: 'text', value: result.value, truncated: result.truncated || cut };
}

function flagsOf(el: Element): ElementFlags {
  const flags: ElementFlags = {};
  if (el.getRootNode() instanceof ShadowRoot) flags.inShadowRoot = true;
  if (el.shadowRoot) {
    flags.shadowHost = 'open';
  } else {
    try {
      // 닫힌 shadow root가 있는지만 확인하고 내부는 수집하지 않는다.
      if (chrome?.dom?.openOrClosedShadowRoot?.(el as HTMLElement)) flags.shadowHost = 'closed';
    } catch {
      // 지원하지 않는 요소
    }
  }
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
    flags.iframe = true;
    try {
      if (!(el as HTMLIFrameElement).contentDocument) flags.iframeInaccessible = true;
    } catch {
      flags.iframeInaccessible = true;
    }
  }
  if (el instanceof SVGElement) flags.svg = true;
  if (REPLACED_TAGS.has(el.tagName)) flags.replaced = true;
  if (FORM_CONTROL_TAGS.has(el.tagName) || el.tagName === 'BUTTON') flags.formControl = true;
  if (el instanceof HTMLElement && el.isContentEditable) flags.contentEditable = true;
  if (el.getClientRects().length === 0) flags.notRendered = true;
  return flags;
}

function imageOf(el: Element): ImageInfo | undefined {
  if (!(el instanceof HTMLImageElement)) return undefined;
  return {
    naturalWidth: el.naturalWidth,
    naturalHeight: el.naturalHeight,
    complete: el.complete,
    hasWidthAttr: el.hasAttribute('width'),
    hasHeightAttr: el.hasAttribute('height'),
    src: el.currentSrc ? sanitizeUrl(el.currentSrc).url : '',
  };
}

function clipsOverflow(cs: CSSStyleDeclaration): boolean {
  if (cs.getPropertyValue('overflow-x') !== 'visible') return true;
  const contain = cs.getPropertyValue('contain');
  return /\b(paint|strict|content)\b/.test(contain);
}

/**
 * 페이지 가로 스크롤을 만드는 요소 후보를 찾는다.
 * 뷰포트 오른쪽(또는 왼쪽) 밖으로 나간 요소 중, 부모는 넘치지 않은 가장 바깥 요소만 남긴다.
 * fixed 요소와 overflow를 자르는 조상 안의 요소는 문서 스크롤에 영향을 주지 않으므로 제외한다.
 */
export function findPageOffenders(limits: CollectionLimits, isOwnNode: (node: Node) => boolean) {
  const scroller = document.scrollingElement ?? document.documentElement;
  const viewportWidth = document.documentElement.clientWidth;
  const body = document.body;
  if (!body || scroller.scrollWidth <= scroller.clientWidth + 1) return { found: [], skipped: 0 };
  const scrollX = window.scrollX;
  const found: Array<{ el: Element; px: number }> = [];
  const stack: Array<[Element, boolean, boolean]> = [[body, false, false]];
  let visited = 0;
  let skipped = 0;
  while (stack.length > 0) {
    const [el, clipped, parentFlagged] = stack.pop()!;
    if (visited >= limits.maxScanElements) {
      skipped += 1;
      continue;
    }
    visited += 1;
    if (!isCollectable(el, isOwnNode)) continue;
    const cs = getComputedStyle(el);
    if (cs.getPropertyValue('display') === 'none') continue;
    if (cs.getPropertyValue('position') === 'fixed') continue;
    let flagged = false;
    if (!clipped) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        const px = Math.max(r.right + scrollX - viewportWidth, -(r.left + scrollX));
        if (px > 1) {
          flagged = true;
          if (!parentFlagged) found.push({ el, px: round(px) });
        }
      }
    }
    const childClipped = clipped || (el !== body && clipsOverflow(cs));
    const children = el.shadowRoot ? el.shadowRoot.children : el.children;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push([child, childClipped, flagged || parentFlagged]);
    }
  }
  found.sort((a, b) => b.px - a.px);
  return { found, skipped };
}

/** 대상 요소의 padding box 밖으로 나간 자손 중 가장 바깥 요소를 찾는다. */
export function findTargetOffenders(target: Element, isOwnNode: (node: Node) => boolean) {
  if (target.scrollWidth <= target.clientWidth + 1 || target.clientWidth === 0) return [];
  const r = target.getBoundingClientRect();
  const innerLeft = r.left + target.clientLeft;
  const innerRight = innerLeft + target.clientWidth;
  const found: Array<{ el: Element; px: number }> = [];
  const stack: Array<[Element, boolean, boolean]> = [];
  const pushChildren = (el: Element, clipped: boolean, flagged: boolean) => {
    const children = el.shadowRoot ? el.shadowRoot.children : el.children;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push([child, clipped, flagged]);
    }
  };
  pushChildren(target, false, false);
  let visited = 0;
  while (stack.length > 0 && visited < MAX_TARGET_SCAN) {
    const [el, clipped, parentFlagged] = stack.pop()!;
    visited += 1;
    if (!isCollectable(el, isOwnNode)) continue;
    const cs = getComputedStyle(el);
    if (cs.getPropertyValue('display') === 'none') continue;
    let flagged = false;
    if (!clipped && cs.getPropertyValue('position') !== 'fixed') {
      const er = el.getBoundingClientRect();
      if (er.width > 0 || er.height > 0) {
        const px = Math.max(er.right - innerRight, innerLeft - er.left);
        if (px > 1) {
          flagged = true;
          if (!parentFlagged) found.push({ el, px: round(px) });
        }
      }
    }
    pushChildren(el, clipped || clipsOverflow(cs), flagged || parentFlagged);
  }
  found.sort((a, b) => b.px - a.px);
  return found.slice(0, MAX_TARGET_OFFENDERS);
}

function pageInfo(): PageInfo {
  const docEl = document.documentElement;
  const scroller = document.scrollingElement ?? docEl;
  const url = sanitizeUrl(location.href);
  return {
    url: url.url,
    urlRedacted: url.redacted,
    title: clip(collapseWhitespace(document.title), 200),
    collectedAt: new Date().toISOString(),
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      clientWidth: docEl.clientWidth,
      clientHeight: docEl.clientHeight,
      dpr: round(window.devicePixelRatio),
    },
    scroll: { x: round(window.scrollX), y: round(window.scrollY) },
    document: {
      scrollWidth: scroller.scrollWidth,
      scrollHeight: scroller.scrollHeight,
      clientWidth: scroller.clientWidth,
      clientHeight: scroller.clientHeight,
      hasHorizontalOverflow: scroller.scrollWidth > scroller.clientWidth + 1,
      hasVerticalOverflow: scroller.scrollHeight > scroller.clientHeight + 1,
      compatMode: document.compatMode,
    },
  };
}

export function collectSnapshot(target: Element, options: CollectOptions): CollectResult {
  const { limits, isOwnNode } = options;
  const entries: Entry[] = [];
  const indexByElement = new Map<Element, number>();
  const push = (el: Element, entry: Omit<Entry, 'el'>) => {
    const existing = indexByElement.get(el);
    if (existing !== undefined) {
      const prev = entries[existing];
      if (prev && prev.role !== entry.role) prev.alsoRoles = [...(prev.alsoRoles ?? []), entry.role];
      if (prev && entry.offenderOf) {
        prev.offenderOf = entry.offenderOf;
        prev.overflowPx = entry.overflowPx;
      }
      return;
    }
    indexByElement.set(el, entries.length);
    entries.push({ el, ...entry });
  };

  push(target, { role: 'target', detail: 'full' });

  const chain: Element[] = [];
  for (let p = composedParent(target); p; p = composedParent(p)) chain.push(p);
  let omittedAncestors = 0;
  chain.forEach((el, i) => {
    const depth = i + 1;
    if (i < limits.maxAncestors || el === document.body || el === document.documentElement) {
      push(el, { role: 'ancestor', depth, detail: depth === 1 ? 'full' : 'compact' });
    } else {
      omittedAncestors += 1;
    }
  });

  const children = renderedChildren(target, isOwnNode);
  children.slice(0, limits.maxChildren).forEach((el) => push(el, { role: 'child', detail: 'compact' }));

  const siblings = siblingsNearestFirst(target, isOwnNode);
  siblings.slice(0, limits.maxSiblings).forEach((el) => push(el, { role: 'sibling', detail: 'compact' }));

  const page = findPageOffenders(limits, isOwnNode);
  page.found
    .slice(0, limits.maxOffenders)
    .forEach(({ el, px }) => push(el, { role: 'offender', detail: 'compact', offenderOf: 'page', overflowPx: px }));
  findTargetOffenders(target, isOwnNode).forEach(({ el, px }) =>
    push(el, { role: 'offender', detail: 'compact', offenderOf: 'target', overflowPx: px }),
  );

  const refs = new Map<string, Element>();
  const limitations: Limitation[] = [];
  const elements: ElementSnapshot[] = entries.map((entry, i) => {
    const id = `E${options.idOffset + i + 1}`;
    refs.set(id, entry.el);
    const el = entry.el;
    const cs = getComputedStyle(el);
    const parent = composedParent(el);
    const parentDisplay = parent ? getComputedStyle(parent).getPropertyValue('display') : undefined;
    const isTarget = entry.role === 'target';
    const { attributes, omitted, classOmitted } = attributesOf(el, limits);
    const textMax = isTarget ? limits.maxTextChars : limits.maxCompactTextChars;
    const skipText = el === document.documentElement || el === document.body;
    const text: TextInfo = skipText ? { kind: 'none' } : collectText(el, textMax, isOwnNode);
    const flags = flagsOf(el);
    const snap: ElementSnapshot = {
      id,
      role: entry.role,
      detail: entry.detail,
      tag: el.tagName.toLowerCase(),
      label: labelOf(el),
      attributes,
      omittedAttributeCount: omitted,
      classOmittedCount: classOmitted,
      text,
      rect: rectOf(el),
      box: boxOf(el),
      styles: pickStyles(cs, parentDisplay, entry.detail, hasDirectText(el)),
      childElementCount: el.childElementCount,
      flags,
    };
    if (entry.depth !== undefined) snap.depth = entry.depth;
    if (entry.alsoRoles) snap.alsoRoles = entry.alsoRoles;
    if (entry.offenderOf) snap.offenderOf = entry.offenderOf;
    if (entry.overflowPx !== undefined) snap.overflowPx = entry.overflowPx;
    if (parent) {
      const siblingsOfEl = parent.shadowRoot && el.getRootNode() === parent.shadowRoot ? parent.shadowRoot.children : parent.children;
      const index = Array.from(siblingsOfEl).indexOf(el);
      if (index >= 0) snap.indexInParent = index + 1;
    }
    const image = imageOf(el);
    if (image) snap.image = image;
    if (isTarget) {
      const before = pseudoStyles(el, '::before');
      const after = pseudoStyles(el, '::after');
      if (before || after) snap.pseudo = { ...(before ? { before } : {}), ...(after ? { after } : {}) };
    }
    if (flags.shadowHost === 'closed') {
      limitations.push({ code: 'closed-shadow-root', elementId: id, message: '닫힌(closed) shadow root 내부는 수집하지 않았습니다.' });
    }
    if (isTarget && flags.inShadowRoot) {
      limitations.push({
        code: 'inside-open-shadow-root',
        elementId: id,
        message: 'open shadow root 안의 요소입니다. slot 배치와 바깥 스타일 상속은 일부만 반영됩니다.',
      });
    }
    if (isTarget && flags.iframe) {
      limitations.push({
        code: 'iframe-not-inspected',
        elementId: id,
        message: flags.iframeInaccessible
          ? 'cross-origin iframe이라 내부 문서에 접근할 수 없습니다. iframe 요소 자체만 수집했습니다.'
          : 'iframe 내부 문서는 선택·수집하지 않습니다. iframe 요소 자체만 수집했습니다.',
      });
    }
    if (isTarget && flags.svg) {
      limitations.push({
        code: 'svg-element',
        elementId: id,
        message: 'SVG 요소는 HTML 박스 모델과 달라 clientWidth 등 일부 값이 0일 수 있습니다.',
      });
    }
    if (isTarget && flags.notRendered) {
      limitations.push({
        code: 'not-rendered',
        elementId: id,
        message: '렌더링 박스가 없는 요소입니다(display:none 또는 display:contents 등).',
      });
    }
    if (isTarget && text.kind === 'excluded') {
      limitations.push({
        code: 'text-excluded',
        elementId: id,
        message: '입력 요소의 값과 편집 가능한 영역의 글은 수집하지 않습니다.',
      });
    }
    return snap;
  });

  if (page.skipped > 0) {
    limitations.push({
      code: 'scan-truncated',
      message: `가로 넘침 원인을 찾을 때 요소 ${limits.maxScanElements}개까지만 검사했습니다(${page.skipped}개 이상 생략).`,
    });
  }

  const snapshot: Snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    id: options.snapshotId,
    page: pageInfo(),
    targetId: `E${options.idOffset + 1}`,
    elements,
    limits,
    omitted: {
      ancestors: omittedAncestors,
      children: Math.max(0, children.length - limits.maxChildren),
      siblings: Math.max(0, siblings.length - limits.maxSiblings),
      offenders: Math.max(0, page.found.length - limits.maxOffenders),
      scanSkipped: page.skipped,
    },
    limitations,
  };
  return { snapshot, refs };
}
