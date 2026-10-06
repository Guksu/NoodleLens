import { describe, expect, it } from 'vitest';
import { analyzeSnapshot, type Finding } from '../../src/shared/analysis';
import { el, snapshot } from './fixtures';

const codes = (findings: Finding[]) => findings.map((f) => f.code);
const find = (findings: Finding[], code: string) => findings.find((f) => f.code === code);

describe('말줄임 검사', () => {
  const parent = el({ id: 'E2', role: 'ancestor', depth: 1, rect: { x: 0, y: 0, width: 400, height: 40 }, styles: { display: 'block', padding: '0px', 'border-width': '0px' } });

  it('white-space가 normal이면 조건 미충족(rule)으로 알린다', () => {
    const target = el({
      id: 'E1',
      role: 'target',
      rect: { x: 0, y: 0, width: 220, height: 40 },
      text: { kind: 'text', value: '긴 안내 문구', truncated: false },
      styles: { display: 'block', 'overflow-x': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'normal' },
    });
    const findings = analyzeSnapshot(snapshot([target, parent]));
    const unmet = find(findings, 'ELLIPSIS_CONDITIONS_UNMET');
    expect(unmet?.kind).toBe('rule');
    expect(unmet?.detail).toContain('white-space');
    expect(unmet?.evidence).toContainEqual({ elementId: 'E1', property: 'white-space', value: 'normal' });
  });

  it('display:inline이면 너비를 제한할 수 없다고 알린다', () => {
    const target = el({
      id: 'E1',
      role: 'target',
      styles: { display: 'inline', 'overflow-x': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' },
    });
    const unmet = find(analyzeSnapshot(snapshot([target, parent])), 'ELLIPSIS_CONDITIONS_UNMET');
    expect(unmet?.detail).toContain('display: inline');
  });

  it('조건이 맞고 내용이 넘치면 정상(ok)으로 본다', () => {
    const target = el({
      id: 'E1',
      role: 'target',
      rect: { x: 0, y: 0, width: 200, height: 20 },
      box: { clientWidth: 200, scrollWidth: 380 },
      styles: { display: 'block', 'overflow-x': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' },
    });
    const findings = analyzeSnapshot(snapshot([target, parent]));
    expect(find(findings, 'ELLIPSIS_ACTIVE')?.kind).toBe('ok');
    expect(codes(findings)).not.toContain('ELLIPSIS_CONDITIONS_UNMET');
  });

  it('조건은 맞지만 요소가 글만큼 커졌으면 측정 사실로 알리고 넘치는 부모를 짚는다', () => {
    const overflowingParent = el({
      id: 'E2',
      role: 'ancestor',
      depth: 1,
      rect: { x: 0, y: 0, width: 344, height: 40 },
      box: { clientWidth: 300, scrollWidth: 344 },
      styles: { display: 'block' },
    });
    const target = el({
      id: 'E1',
      role: 'target',
      rect: { x: 0, y: 0, width: 344, height: 20 },
      styles: { display: 'block', 'overflow-x': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' },
    });
    const finding = find(analyzeSnapshot(snapshot([target, overflowingParent])), 'ELLIPSIS_NOT_CONSTRAINED');
    expect(finding?.kind).toBe('fact');
    expect(finding?.detail).toContain('[E2]');
  });
});

describe('flex/grid 항목 min-width:auto 검사', () => {
  it('flex 행의 항목이 컨테이너보다 넓고 min-width:auto면 가능성(hint)으로 알린다', () => {
    const target = el({
      id: 'E1',
      role: 'target',
      rect: { x: 60, y: 0, width: 344, height: 20 },
      styles: { display: 'block', 'overflow-x': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'min-width': 'auto' },
    });
    const body = el({ id: 'E2', role: 'ancestor', depth: 1, rect: { x: 60, y: 0, width: 344, height: 40 }, styles: { display: 'block', 'min-width': 'auto' } });
    const row = el({
      id: 'E3',
      role: 'ancestor',
      depth: 2,
      rect: { x: 0, y: 0, width: 300, height: 60 },
      box: { clientWidth: 298, scrollWidth: 414 },
      styles: { display: 'flex', 'flex-direction': 'row', padding: '10px', 'border-width': '1px' },
    });
    const finding = find(analyzeSnapshot(snapshot([target, body, row])), 'FLEX_ITEM_MIN_WIDTH_AUTO');
    expect(finding?.kind).toBe('hint');
    expect(finding?.title).toContain('[E2]');
    expect(finding?.evidence[0]).toEqual({ elementId: 'E2', property: 'min-width', value: 'auto' });
  });

  it('flex 컨테이너가 넘치지 않고 항목도 들어맞으면 알리지 않는다(정상 화면을 문제로 보지 않음)', () => {
    const target = el({ id: 'E1', role: 'target', rect: { x: 10, y: 0, width: 120, height: 20 }, styles: { display: 'block', 'min-width': 'auto' } });
    const row = el({ id: 'E2', role: 'ancestor', depth: 1, rect: { x: 0, y: 0, width: 300, height: 40 }, styles: { display: 'flex' } });
    expect(codes(analyzeSnapshot(snapshot([target, row])))).not.toContain('FLEX_ITEM_MIN_WIDTH_AUTO');
  });

  it('grid 항목이면 원래 트랙 정의를 알 수 없다고 밝힌다', () => {
    const target = el({ id: 'E1', role: 'target', rect: { x: 0, y: 0, width: 600, height: 20 }, styles: { display: 'block', 'min-width': 'auto' } });
    const grid = el({
      id: 'E2',
      role: 'ancestor',
      depth: 1,
      rect: { x: 0, y: 0, width: 320, height: 40 },
      box: { clientWidth: 320, scrollWidth: 600 },
      styles: { display: 'grid', 'grid-template-columns': '600px' },
    });
    const finding = find(analyzeSnapshot(snapshot([target, grid])), 'GRID_ITEM_MIN_WIDTH_AUTO');
    expect(finding?.detail).toContain('computed style로 알 수 없습니다');
  });
});

describe('가로 넘침 검사', () => {
  it('문서 넘침과 뷰포트 밖 요소를 측정 사실로 알린다', () => {
    const target = el({ id: 'E1', role: 'target', rect: { x: 16, y: 0, width: 1200, height: 40 }, styles: { width: '1200px' } });
    const html = el({ id: 'E2', role: 'ancestor', depth: 2, tag: 'html', label: 'html', styles: { 'overflow-x': 'visible' } });
    const snap = snapshot([target, html], {});
    snap.page.viewport.clientWidth = 900;
    snap.page.document = { ...snap.page.document, scrollWidth: 1232, clientWidth: 900, hasHorizontalOverflow: true };
    target.offenderOf = 'page';
    target.overflowPx = 332;
    const findings = analyzeSnapshot(snap);
    expect(find(findings, 'PAGE_HSCROLL')?.kind).toBe('fact');
    expect(find(findings, 'PAGE_OFFENDERS')?.detail).toContain('332px');
    expect(find(findings, 'TARGET_EXCEEDS_VIEWPORT')).toBeDefined();
  });

  it('넘침이 없으면 정상으로 알린다', () => {
    const findings = analyzeSnapshot(snapshot([el({ id: 'E1', role: 'target' })]));
    expect(find(findings, 'PAGE_NO_HSCROLL')?.kind).toBe('ok');
    expect(codes(findings)).not.toContain('PAGE_HSCROLL');
  });

  it('대상 내용이 넘치면 overflow-x 값에 따라 보이는지·잘리는지 설명한다', () => {
    const target = el({ id: 'E1', role: 'target', box: { clientWidth: 100, scrollWidth: 160 }, styles: { 'overflow-x': 'hidden' } });
    const finding = find(analyzeSnapshot(snapshot([target])), 'TARGET_CONTENT_OVERFLOW');
    expect(finding?.detail).toContain('잘립니다');
  });
});

describe('정렬 정보', () => {
  it('flex column에서는 가로 위치를 align-items가 정한다고 설명하고 차이를 수치로 준다', () => {
    const target = el({ id: 'E1', role: 'target', rect: { x: 1, y: 40, width: 100, height: 40 } });
    const parent = el({
      id: 'E2',
      role: 'ancestor',
      depth: 1,
      rect: { x: 0, y: 0, width: 300, height: 120 },
      styles: { display: 'flex', 'flex-direction': 'column', 'justify-content': 'center', 'align-items': 'flex-start', 'border-width': '1px', padding: '0px' },
    });
    const finding = find(analyzeSnapshot(snapshot([target, parent])), 'ALIGNMENT_OFFSET');
    expect(finding?.kind).toBe('info');
    expect(finding?.title).toContain('-99px');
    expect(finding?.detail).toContain('align-items');
  });

  it('가운데에 있으면 그렇다고만 알린다', () => {
    const target = el({ id: 'E1', role: 'target', rect: { x: 100, y: 20, width: 100, height: 40 } });
    const parent = el({ id: 'E2', role: 'ancestor', depth: 1, rect: { x: 0, y: 0, width: 300, height: 80 }, styles: { display: 'flex', 'justify-content': 'center' } });
    expect(find(analyzeSnapshot(snapshot([target, parent])), 'ALIGNMENT_OFFSET')?.title).toContain('가운데에 있음');
  });
});

describe('이미지 검사', () => {
  it('부모보다 넓은 이미지와 크기 힌트 없음을 알린다', () => {
    const target = el({
      id: 'E1',
      role: 'target',
      tag: 'img',
      rect: { x: 8, y: 0, width: 900, height: 300 },
      styles: { display: 'inline', 'max-width': 'none', 'aspect-ratio': 'auto', height: '300px' },
      image: { naturalWidth: 900, naturalHeight: 300, complete: true, hasWidthAttr: false, hasHeightAttr: false, src: 'data:[생략]' },
    });
    const parent = el({ id: 'E2', role: 'ancestor', depth: 1, rect: { x: 0, y: 0, width: 338, height: 320 }, styles: { display: 'block', padding: '8px', 'border-width': '1px' } });
    const findings = analyzeSnapshot(snapshot([target, parent]));
    expect(find(findings, 'IMG_WIDER_THAN_PARENT')?.kind).toBe('fact');
    expect(find(findings, 'IMG_NO_SIZE_HINT')?.kind).toBe('hint');
  });

  it('width·height 속성이 있으면 크기 힌트 경고를 내지 않는다', () => {
    const target = el({
      id: 'E1',
      role: 'target',
      tag: 'img',
      rect: { x: 8, y: 0, width: 320, height: 107 },
      styles: { display: 'block', 'max-width': '100%', 'aspect-ratio': 'auto 900 / 300' },
      image: { naturalWidth: 900, naturalHeight: 300, complete: true, hasWidthAttr: true, hasHeightAttr: true, src: '' },
    });
    const parent = el({ id: 'E2', role: 'ancestor', depth: 1, rect: { x: 0, y: 0, width: 338, height: 130 }, styles: { display: 'block', padding: '8px', 'border-width': '1px' } });
    const findings = analyzeSnapshot(snapshot([target, parent]));
    expect(codes(findings)).not.toContain('IMG_NO_SIZE_HINT');
    expect(codes(findings)).not.toContain('IMG_WIDER_THAN_PARENT');
  });
});
