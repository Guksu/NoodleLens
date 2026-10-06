/**
 * 규칙 기반 기본 검사.
 *
 * 스냅샷 값만으로 판단할 수 있는 것을 일반 코드로 확인한다. LLM은 이 결과를 해석하는 데 쓴다.
 * - fact: 측정값 비교로 확인된 사실 (예: scrollWidth > clientWidth)
 * - rule: CSS 동작 조건과 현재 값의 관계 (예: text-overflow는 overflow가 visible이면 동작하지 않음)
 * - hint: 가능성 있는 원인. 다른 원인이 있을 수 있어 추가 확인이 필요
 * - ok: 확인한 조건이 정상
 * 정상 화면을 오류로 단정하지 않도록, 사용자 의도를 알 수 없는 항목은 info/hint로만 낸다.
 */
import { getAncestors, getParent, getTarget, type ElementSnapshot, type Snapshot } from './snapshot';
import { isFlexDisplay, isGridDisplay } from './styleProps';

export type FindingKind = 'fact' | 'rule' | 'hint' | 'ok' | 'info';
export type FindingCategory = 'overflow' | 'ellipsis' | 'alignment' | 'sizing' | 'image' | 'limitation';

export interface Evidence {
  elementId: string;
  property?: string;
  value?: string;
}

export interface Finding {
  code: string;
  category: FindingCategory;
  kind: FindingKind;
  title: string;
  detail: string;
  evidence: Evidence[];
}

const EPSILON = 1;

function px(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function fmt(value: number): string {
  return `${Math.round(value * 10) / 10}px`;
}

function boxSides(value: string | undefined): [number, number, number, number] {
  const parts = (value ?? '0px').trim().split(/\s+/).map((part) => px(part) ?? 0);
  const [t = 0, r = t, b = t, l = r] = parts;
  return [t, r, b, l];
}

/** 요소의 content box를 뷰포트 좌표로 구한다 */
export function contentBox(el: ElementSnapshot) {
  const [, padR, , padL] = boxSides(el.styles.padding);
  const [padT, , padB] = boxSides(el.styles.padding);
  const [bT, bR, bB, bL] = boxSides(el.styles['border-width']);
  return {
    left: el.rect.left + bL + padL,
    right: el.rect.right - bR - padR,
    top: el.rect.top + bT + padT,
    bottom: el.rect.bottom - bB - padB,
  };
}

function isInlineLevel(display: string | undefined): boolean {
  return display === 'inline';
}

function overflowClips(value: string | undefined): boolean {
  return value === 'hidden' || value === 'clip' || value === 'scroll' || value === 'auto';
}

function nowrap(el: ElementSnapshot): boolean {
  const ws = el.styles['white-space'];
  const mode = el.styles['text-wrap-mode'];
  return ws === 'nowrap' || ws === 'pre' || mode === 'nowrap';
}

function hasText(el: ElementSnapshot): boolean {
  return el.text.kind === 'text' && el.text.value.length > 0;
}

function ev(el: ElementSnapshot, property?: string): Evidence {
  if (!property) return { elementId: el.id };
  const value = el.styles[property];
  return value === undefined ? { elementId: el.id, property } : { elementId: el.id, property, value };
}

function checkPageOverflow(snapshot: Snapshot, out: Finding[]) {
  const doc = snapshot.page.document;
  const html = snapshot.elements.find((el) => el.tag === 'html');
  const body = snapshot.elements.find((el) => el.tag === 'body');
  if (!doc.hasHorizontalOverflow) {
    out.push({
      code: 'PAGE_NO_HSCROLL',
      category: 'overflow',
      kind: 'ok',
      title: '페이지 가로 넘침 없음',
      detail: `문서 scrollWidth ${doc.scrollWidth}px ≤ clientWidth ${doc.clientWidth}px`,
      evidence: html ? [ev(html)] : [],
    });
    return;
  }
  const hidden = [html, body].filter(
    (el): el is ElementSnapshot => Boolean(el && (el.styles['overflow-x'] === 'hidden' || el.styles['overflow-x'] === 'clip')),
  );
  out.push({
    code: 'PAGE_HSCROLL',
    category: 'overflow',
    kind: 'fact',
    title: '페이지에 가로 넘침이 있음',
    detail:
      `문서 scrollWidth ${doc.scrollWidth}px > clientWidth ${doc.clientWidth}px (${doc.scrollWidth - doc.clientWidth}px 넘침)` +
      (hidden.length > 0
        ? `. ${hidden.map((el) => `${el.tag}의 overflow-x: ${el.styles['overflow-x']}`).join(', ')} 때문에 스크롤바는 숨겨졌을 수 있음`
        : ''),
    evidence: [...(html ? [ev(html, 'overflow-x')] : []), ...hidden.filter((el) => el !== html).map((el) => ev(el, 'overflow-x'))],
  });
  const offenders = snapshot.elements.filter((el) => el.offenderOf === 'page');
  if (offenders.length > 0) {
    out.push({
      code: 'PAGE_OFFENDERS',
      category: 'overflow',
      kind: 'fact',
      title: `뷰포트 밖으로 나간 요소 ${offenders.length}개`,
      detail: offenders
        .map((el) => `[${el.id}] ${el.label} 너비 ${fmt(el.rect.width)}, ${fmt(el.overflowPx ?? 0)} 넘침`)
        .join(' / '),
      evidence: offenders.map((el) => ({ elementId: el.id, property: 'width', value: el.styles.width ?? fmt(el.rect.width) })),
    });
  } else if (snapshot.omitted.scanSkipped > 0) {
    out.push({
      code: 'PAGE_OFFENDERS_UNKNOWN',
      category: 'overflow',
      kind: 'info',
      title: '넘침 원인 요소를 찾지 못함',
      detail: '검사 상한에 걸려 일부 요소를 확인하지 못했습니다.',
      evidence: [],
    });
  }
}

function checkTargetOverflow(snapshot: Snapshot, target: ElementSnapshot, parent: ElementSnapshot | undefined, out: Finding[]) {
  const { box } = target;
  if (box.clientWidth > 0 && box.scrollWidth > box.clientWidth + EPSILON) {
    const overflowX = target.styles['overflow-x'];
    const inner = snapshot.elements.filter((el) => el.offenderOf === 'target');
    out.push({
      code: 'TARGET_CONTENT_OVERFLOW',
      category: 'overflow',
      kind: 'fact',
      title: '선택한 요소의 내용이 가로로 넘침',
      detail:
        `scrollWidth ${box.scrollWidth}px > clientWidth ${box.clientWidth}px (${box.scrollWidth - box.clientWidth}px). ` +
        (overflowX === 'visible'
          ? '내용이 박스 밖으로 보이게 넘칩니다(overflow-x: visible).'
          : `overflow-x: ${overflowX}라 넘친 부분은 ${overflowX === 'hidden' || overflowX === 'clip' ? '잘립니다' : '스크롤됩니다'}.`) +
        (inner.length > 0 ? ` 넘친 자손: ${inner.map((el) => `[${el.id}] ${el.label}`).join(', ')}` : ''),
      evidence: [ev(target, 'overflow-x'), ...inner.map((el) => ev(el, 'width'))],
    });
  }
  if (parent && parent.tag !== 'html') {
    const content = contentBox(parent);
    const right = target.rect.right - content.right;
    const left = content.left - target.rect.left;
    const amount = Math.max(right, left);
    if (amount > EPSILON && target.rect.width > 0) {
      out.push({
        code: 'TARGET_EXCEEDS_PARENT',
        category: 'overflow',
        kind: 'fact',
        title: '선택한 요소가 부모 콘텐츠 영역보다 넓거나 밖으로 나감',
        detail: `요소 너비 ${fmt(target.rect.width)}, 부모 콘텐츠 너비 ${fmt(content.right - content.left)}. ${right > left ? '오른쪽' : '왼쪽'}으로 ${fmt(amount)} 나감.`,
        evidence: [ev(target, 'width'), ev(parent, 'width'), ev(parent, 'padding')],
      });
    }
  }
  const viewportWidth = snapshot.page.viewport.clientWidth;
  const docRight = target.rect.right + snapshot.page.scroll.x;
  if (target.rect.width > 0 && docRight > viewportWidth + EPSILON && target.styles.position !== 'fixed') {
    out.push({
      code: 'TARGET_EXCEEDS_VIEWPORT',
      category: 'overflow',
      kind: 'fact',
      title: '선택한 요소가 뷰포트 오른쪽 밖으로 나감',
      detail: `요소 오른쪽 끝 ${fmt(docRight)} > 뷰포트 너비 ${viewportWidth}px`,
      evidence: [ev(target, 'width')],
    });
  }
}

/** flex/grid 항목의 min-width:auto 때문에 줄어들지 못하는지 */
function checkMinWidthAuto(snapshot: Snapshot, target: ElementSnapshot, out: Finding[]) {
  const chain = [target, ...getAncestors(snapshot)];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const item = chain[i];
    const container = chain[i + 1];
    if (!item || !container || container.depth !== (item.role === 'target' ? 1 : (item.depth ?? 0) + 1)) continue;
    const display = container.styles.display;
    const flexRow = isFlexDisplay(display) && !(container.styles['flex-direction'] ?? 'row').startsWith('column');
    const grid = isGridDisplay(display);
    if (!flexRow && !grid) continue;
    if (item.styles['min-width'] !== 'auto') continue;
    const containerOverflows = container.box.scrollWidth > container.box.clientWidth + EPSILON;
    const content = contentBox(container);
    const itemWider = item.rect.width > content.right - content.left + EPSILON;
    const itemContentOverflows = item.box.scrollWidth > item.box.clientWidth + EPSILON;
    if (!containerOverflows && !itemWider && !(itemContentOverflows && nowrap(target))) continue;
    out.push({
      code: grid ? 'GRID_ITEM_MIN_WIDTH_AUTO' : 'FLEX_ITEM_MIN_WIDTH_AUTO',
      category: 'sizing',
      kind: 'hint',
      title: `${grid ? 'grid' : 'flex'} 항목 [${item.id}]이 내용보다 작게 줄어들지 못할 수 있음`,
      detail:
        `[${item.id}]는 ${grid ? 'grid' : 'flex'} 컨테이너 [${container.id}]의 항목이고 min-width: auto입니다. ` +
        (grid
          ? 'grid 트랙이 auto나 1fr(= minmax(auto, 1fr))이면 내용의 최소 너비보다 줄지 않습니다. 원래 트랙 정의는 computed style로 알 수 없습니다.'
          : 'flex 항목의 min-width: auto는 내용의 최소 너비 아래로 줄어들지 않게 합니다.') +
        ` (컨테이너 넘침: ${containerOverflows ? '예' : '아니오'}, 항목이 컨테이너보다 넓음: ${itemWider ? '예' : '아니오'})`,
      evidence: [ev(item, 'min-width'), ev(container, 'display'), ...(grid ? [ev(container, 'grid-template-columns')] : [ev(item, 'flex-shrink')])],
    });
    return;
  }
}

function checkEllipsis(snapshot: Snapshot, target: ElementSnapshot, parent: ElementSnapshot | undefined, out: Finding[]) {
  const textOverflow = target.styles['text-overflow'];
  const clamp = target.styles['-webkit-line-clamp'];
  const wantsEllipsis = textOverflow === 'ellipsis' || (textOverflow !== undefined && textOverflow !== 'clip');
  const wantsClamp = clamp !== undefined && clamp !== 'none';
  if (!wantsEllipsis && !wantsClamp) {
    if (hasText(target) && target.box.scrollWidth > target.box.clientWidth + EPSILON && nowrap(target)) {
      out.push({
        code: 'ELLIPSIS_NOT_SET',
        category: 'ellipsis',
        kind: 'info',
        title: '글이 넘치지만 text-overflow가 설정되지 않음',
        detail: `text-overflow: ${textOverflow ?? 'clip'}. 말줄임을 원한다면 text-overflow: ellipsis가 필요합니다.`,
        evidence: [ev(target, 'text-overflow')],
      });
    }
    return;
  }

  if (wantsClamp) {
    const display = target.styles.display;
    const problems: string[] = [];
    if (display !== '-webkit-box' && display !== '-webkit-inline-box') problems.push(`display: ${display} (-webkit-box 필요)`);
    if (target.styles['-webkit-box-orient'] !== 'vertical') problems.push(`-webkit-box-orient: ${target.styles['-webkit-box-orient'] ?? '없음'} (vertical 필요)`);
    if (!overflowClips(target.styles['overflow-y']) && !overflowClips(target.styles['overflow-x'])) problems.push('overflow: visible (hidden 필요)');
    out.push({
      code: problems.length ? 'LINE_CLAMP_CONDITIONS_UNMET' : 'LINE_CLAMP_CONDITIONS_MET',
      category: 'ellipsis',
      kind: problems.length ? 'rule' : 'ok',
      title: problems.length ? '여러 줄 말줄임(-webkit-line-clamp) 조건 미충족' : '여러 줄 말줄임 조건 충족',
      detail: problems.length ? problems.join(', ') : `-webkit-line-clamp: ${clamp}`,
      evidence: [ev(target, '-webkit-line-clamp'), ev(target, 'display'), ev(target, '-webkit-box-orient'), ev(target, 'overflow-y')],
    });
  }

  if (!wantsEllipsis) return;
  const unmet: Evidence[] = [];
  const reasons: string[] = [];
  const display = target.styles.display;
  if (isInlineLevel(display)) {
    reasons.push(`display: inline이라 너비를 제한할 수 없고 text-overflow가 적용되지 않습니다`);
    unmet.push(ev(target, 'display'));
  }
  if (isFlexDisplay(display) || isGridDisplay(display)) {
    reasons.push(`display: ${display}이면 안쪽 글은 익명 flex/grid 항목이 되어, 이 요소의 text-overflow로는 말줄임되지 않습니다`);
    unmet.push(ev(target, 'display'));
  }
  if (!overflowClips(target.styles['overflow-x'])) {
    reasons.push(`overflow-x: ${target.styles['overflow-x']} — text-overflow는 넘친 내용을 자를 때만 동작합니다(hidden 등 필요)`);
    unmet.push(ev(target, 'overflow-x'));
  }
  if (!nowrap(target) && !wantsClamp) {
    reasons.push(`white-space: ${target.styles['white-space'] ?? 'normal'} — 줄바꿈되면 가로로 넘치지 않아 한 줄 말줄임이 생기지 않습니다`);
    unmet.push(ev(target, 'white-space'));
  }
  if (reasons.length > 0) {
    out.push({
      code: 'ELLIPSIS_CONDITIONS_UNMET',
      category: 'ellipsis',
      kind: 'rule',
      title: 'text-overflow: ellipsis 동작 조건 미충족',
      detail: reasons.join(' / '),
      evidence: [ev(target, 'text-overflow'), ...unmet],
    });
    return;
  }
  const overflowing = target.box.scrollWidth > target.box.clientWidth + EPSILON;
  if (overflowing) {
    out.push({
      code: 'ELLIPSIS_ACTIVE',
      category: 'ellipsis',
      kind: 'ok',
      title: '말줄임 조건 충족, 현재 글이 잘려 말줄임 표시 중일 가능성 높음',
      detail: `scrollWidth ${target.box.scrollWidth}px > clientWidth ${target.box.clientWidth}px`,
      evidence: [ev(target, 'text-overflow'), ev(target, 'overflow-x'), ev(target, 'white-space')],
    });
    return;
  }
  const parentInfo =
    parent && parent.box.scrollWidth > parent.box.clientWidth + EPSILON
      ? ` 부모 [${parent.id}]는 넘치고 있어(scrollWidth ${parent.box.scrollWidth}px > clientWidth ${parent.box.clientWidth}px), 요소가 줄지 않고 글 길이만큼 늘어났을 수 있습니다.`
      : '';
  out.push({
    code: 'ELLIPSIS_NOT_CONSTRAINED',
    category: 'ellipsis',
    kind: 'fact',
    title: '말줄임 조건은 맞지만 요소가 글보다 좁지 않음',
    detail: `scrollWidth ${target.box.scrollWidth}px ≤ clientWidth ${target.box.clientWidth}px — 잘라낼 내용이 없습니다. 요소의 너비가 제한되지 않고 내용만큼 커졌는지 확인하세요.${parentInfo}`,
    evidence: [ev(target, 'width'), ev(target, 'max-width'), ...(parent ? [ev(parent, 'display')] : [])],
  });
}

function checkAlignment(target: ElementSnapshot, parent: ElementSnapshot | undefined, siblings: number, out: Finding[]) {
  if (!parent || target.rect.width === 0 || target.styles.position === 'absolute' || target.styles.position === 'fixed') return;
  const content = contentBox(parent);
  const centerX = (content.left + content.right) / 2;
  const centerY = (content.top + content.bottom) / 2;
  const dx = target.rect.left + target.rect.width / 2 - centerX;
  const dy = target.rect.top + target.rect.height / 2 - centerY;
  const display = parent.styles.display;
  const controls: Evidence[] = [];
  let axisNote = '';
  if (isFlexDisplay(display)) {
    const column = (parent.styles['flex-direction'] ?? 'row').startsWith('column');
    axisNote = column
      ? `부모는 flex-direction: ${parent.styles['flex-direction']}라 가로 위치는 align-items/align-self, 세로 위치는 justify-content가 정합니다.`
      : `부모는 flex 행 방향이라 가로 위치는 justify-content(와 margin auto), 세로 위치는 align-items/align-self가 정합니다.`;
    controls.push(ev(parent, 'flex-direction'), ev(parent, 'justify-content'), ev(parent, 'align-items'), ev(target, 'align-self'), ev(target, 'margin'));
  } else if (isGridDisplay(display)) {
    axisNote = '부모가 grid라 칸 안의 가로 위치는 justify-items/justify-self, 세로 위치는 align-items/align-self가 정합니다.';
    controls.push(ev(parent, 'justify-items'), ev(parent, 'align-items'), ev(target, 'justify-self'), ev(target, 'align-self'));
  } else {
    const inlineLevel = (target.styles.display ?? '').startsWith('inline');
    axisNote = inlineLevel
      ? `요소가 ${target.styles.display}라 부모의 text-align(${parent.styles['text-align'] ?? '알 수 없음'})이 가로 위치를 정합니다.`
      : `부모가 ${display}이고 요소가 블록 수준이라 가로 가운데 정렬은 margin-left/right: auto(그리고 width < 부모)로 정해집니다. text-align은 블록 상자 자체를 옮기지 않습니다.`;
    controls.push(ev(parent, 'text-align'), ev(target, 'display'), ev(target, 'margin'));
  }
  const centered = Math.abs(dx) <= EPSILON;
  out.push({
    code: 'ALIGNMENT_OFFSET',
    category: 'alignment',
    kind: 'info',
    title: centered ? '부모 콘텐츠 영역 기준 가로 가운데에 있음' : `부모 콘텐츠 영역 가로 중심에서 ${fmt(dx)} 벗어남`,
    detail:
      `가로 중심 차이 ${fmt(dx)}, 세로 중심 차이 ${fmt(dy)}. ${axisNote}` +
      (siblings > 0 ? ` 같은 부모 안에 형제 요소가 ${siblings}개 있어 정렬은 형제와 함께 계산됩니다.` : ''),
    evidence: controls,
  });
}

function checkImage(target: ElementSnapshot, parent: ElementSnapshot | undefined, out: Finding[]) {
  const image = target.image;
  if (!image) return;
  if (!image.complete || image.naturalWidth === 0) {
    out.push({
      code: 'IMG_NOT_LOADED',
      category: 'image',
      kind: 'fact',
      title: '이미지가 아직 로드되지 않았거나 실패함',
      detail: `complete: ${image.complete}, naturalWidth: ${image.naturalWidth}`,
      evidence: [{ elementId: target.id }],
    });
  }
  if (parent) {
    const content = contentBox(parent);
    const available = content.right - content.left;
    if (target.rect.width > available + EPSILON) {
      out.push({
        code: 'IMG_WIDER_THAN_PARENT',
        category: 'image',
        kind: 'fact',
        title: '이미지가 부모 콘텐츠 영역보다 넓음',
        detail: `이미지 너비 ${fmt(target.rect.width)} (원본 ${image.naturalWidth}×${image.naturalHeight}), 부모 콘텐츠 너비 ${fmt(available)}, max-width: ${target.styles['max-width']}`,
        evidence: [ev(target, 'max-width'), ev(target, 'width'), ev(parent, 'width')],
      });
    }
  }
  const aspect = target.styles['aspect-ratio'] ?? 'auto';
  const sized = image.hasWidthAttr && image.hasHeightAttr;
  const explicitHeight = target.styles.height !== undefined && !/^0(px)?$/.test(target.styles.height) && target.attributes.style?.includes('height');
  if (!sized && aspect === 'auto' && !explicitHeight) {
    out.push({
      code: 'IMG_NO_SIZE_HINT',
      category: 'image',
      kind: 'hint',
      title: '이미지 크기 힌트(width·height 속성 또는 aspect-ratio)가 없음',
      detail:
        '로드 전에는 높이를 알 수 없어, 로드되면서 아래 내용을 밀어낼 수 있습니다(레이아웃 이동). ' +
        '현재 스냅샷은 로드 후 시점이라 실제 이동 여부는 DevTools Performance의 Layout Shift 기록으로 확인해야 합니다.',
      evidence: [ev(target, 'aspect-ratio'), ev(target, 'height')],
    });
  }
  if (target.styles.display === 'inline' && parent) {
    const gap = parent.rect.height - target.rect.height;
    if (gap > 0.5 && gap < 8 && parent.childElementCount === 1) {
      out.push({
        code: 'IMG_INLINE_BASELINE_GAP',
        category: 'image',
        kind: 'hint',
        title: 'inline 이미지 아래 기준선 여백 가능성',
        detail: `부모 높이가 이미지보다 ${fmt(gap)} 큽니다. img가 inline이면 글자 기준선 아래 공간이 생깁니다(display:block 또는 vertical-align으로 확인).`,
        evidence: [ev(target, 'display'), ev(target, 'vertical-align')],
      });
    }
  }
}

function limitationFindings(snapshot: Snapshot, out: Finding[]) {
  for (const limitation of snapshot.limitations) {
    out.push({
      code: `LIMIT_${limitation.code.toUpperCase().replace(/-/g, '_')}`,
      category: 'limitation',
      kind: 'info',
      title: '수집 한계',
      detail: limitation.message,
      evidence: limitation.elementId ? [{ elementId: limitation.elementId }] : [],
    });
  }
}

export function analyzeSnapshot(snapshot: Snapshot): Finding[] {
  const out: Finding[] = [];
  const target = getTarget(snapshot);
  const parent = getParent(snapshot);
  const siblings = snapshot.elements.filter((el) => el.role === 'sibling').length + snapshot.omitted.siblings;
  checkPageOverflow(snapshot, out);
  checkTargetOverflow(snapshot, target, parent, out);
  checkMinWidthAuto(snapshot, target, out);
  checkEllipsis(snapshot, target, parent, out);
  checkAlignment(target, parent, siblings, out);
  checkImage(target, parent, out);
  limitationFindings(snapshot, out);
  return out;
}

export function summarizeFindings(findings: Finding[]): { issues: number; hints: number; ok: number } {
  return {
    issues: findings.filter((f) => f.kind === 'fact' || f.kind === 'rule').filter((f) => f.code !== 'ALIGNMENT_OFFSET').length,
    hints: findings.filter((f) => f.kind === 'hint').length,
    ok: findings.filter((f) => f.kind === 'ok').length,
  };
}
