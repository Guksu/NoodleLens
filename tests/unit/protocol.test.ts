import { describe, expect, it } from 'vitest';
import { MAX_ELEMENTS_PER_SNAPSHOT, parseContentMessage, parsePanelMessage, validateSnapshot } from '../../src/shared/protocol';
import { el, snapshot } from './fixtures';

const valid = () =>
  snapshot([
    el({ id: 'E1', role: 'target', attributes: { class: 'a b', role: 'button' }, styles: { display: 'block', width: '10px' } }),
    el({ id: 'E2', role: 'ancestor', depth: 1 }),
  ]);

describe('패널 → content 메시지 검증', () => {
  it('알려진 형식만 받는다', () => {
    expect(parsePanelMessage({ kind: 'pick-start', reqId: 'p1', idOffset: 0 })).toEqual({ kind: 'pick-start', reqId: 'p1', idOffset: 0 });
    expect(parsePanelMessage({ kind: 'pick-start', reqId: 'p1', idOffset: -1 })).toBeNull();
    expect(parsePanelMessage({ kind: 'pick-start', reqId: '<script>', idOffset: 0 })).toBeNull();
    expect(parsePanelMessage({ kind: 'highlight', reqId: 'r', snapshotId: 's1', elementId: 'E1' })).toBeNull();
    expect(parsePanelMessage({ kind: 'highlight', reqId: 'r', snapshotId: 's1', elementId: 'E1', scroll: true })).not.toBeNull();
    expect(parsePanelMessage({ kind: 'eval', code: 'alert(1)' })).toBeNull();
    expect(parsePanelMessage(null)).toBeNull();
  });
});

describe('content → 패널 메시지·스냅샷 검증', () => {
  it('정상 스냅샷을 통과시킨다', () => {
    expect(validateSnapshot(valid())).not.toBeNull();
    expect(parseContentMessage({ kind: 'picked', reqId: 'p1', snapshot: valid() })).toMatchObject({ kind: 'picked' });
  });

  it('허용하지 않은 속성(value 등)이나 스타일 키가 있으면 거부한다', () => {
    const withValue = valid();
    withValue.elements[0]!.attributes = { value: 'secret' };
    expect(validateSnapshot(withValue)).toBeNull();

    const withStyle = valid();
    withStyle.elements[0]!.styles = { 'background-image': 'url(https://evil)' };
    expect(validateSnapshot(withStyle)).toBeNull();
  });

  it('대상이 없거나 두 개이거나 id가 중복되면 거부한다', () => {
    const noTarget = valid();
    noTarget.targetId = 'E9';
    expect(validateSnapshot(noTarget)).toBeNull();

    const twoTargets = valid();
    twoTargets.elements[1]!.role = 'target';
    expect(validateSnapshot(twoTargets)).toBeNull();

    const duplicate = valid();
    duplicate.elements[1]!.id = 'E1';
    expect(validateSnapshot(duplicate)).toBeNull();
  });

  it('요소 수·문자열 길이 상한을 넘으면 거부한다', () => {
    const many = valid();
    many.elements = Array.from({ length: MAX_ELEMENTS_PER_SNAPSHOT + 1 }, (_, i) => el({ id: `E${i + 1}`, role: i === 0 ? 'target' : 'child' }));
    expect(validateSnapshot(many)).toBeNull();

    const longText = valid();
    longText.elements[0]!.text = { kind: 'text', value: 'x'.repeat(5000), truncated: false };
    expect(validateSnapshot(longText)).toBeNull();
  });

  it('숫자가 아닌 측정값과 알 수 없는 플래그를 거부한다', () => {
    const badRect = valid();
    (badRect.elements[0]!.rect as unknown as Record<string, unknown>).width = 'wide';
    expect(validateSnapshot(badRect)).toBeNull();

    const badFlag = valid();
    (badFlag.elements[0]!.flags as Record<string, unknown>).isAdmin = true;
    expect(validateSnapshot(badFlag)).toBeNull();
  });

  it('형식이 맞지 않는 content 메시지는 버린다', () => {
    expect(parseContentMessage({ kind: 'picked', reqId: 'p1', snapshot: { bogus: true } })).toBeNull();
    expect(parseContentMessage({ kind: 'pick-cancelled', reqId: 'p1', reason: 'whatever' })).toBeNull();
    expect(parseContentMessage({ kind: 'highlight-result', reqId: 'p1', status: 'connected' })).toEqual({
      kind: 'highlight-result',
      reqId: 'p1',
      status: 'connected',
    });
  });
});
