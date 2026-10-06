/**
 * 요소 선택·수집·강조 E2E. 실제 사이드 패널과 데모 페이지에서 확인한다.
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptConsent,
  center,
  launch,
  openDemo,
  openPanel,
  overlayPresent,
  pick,
  sleep,
  startPicking,
  text,
  type Env,
} from './harness';

let env: Env;
let page: Page;
let panel: Page;

beforeAll(async () => {
  env = await launch();
  page = await openDemo(env);
  panel = await openPanel(env, page);
  await acceptConsent(panel);
});

afterAll(async () => {
  await env?.close();
});

async function payload(): Promise<string> {
  await panel.click('.attach-card-actions .chip-btn:nth-child(2)');
  await panel.waitForSelector('.payload');
  const value = await text(panel, '.payload');
  await panel.click('.sheet-head .icon-btn');
  await panel.waitForFunction(() => !document.querySelector('.sheet'));
  return value;
}

describe('요소 선택', () => {
  it('아이콘으로 연 탭은 접근 권한이 있고 페이지 정보가 보인다', async () => {
    const row = await text(panel, '.page-row');
    expect(row).toContain('NoodleLens 데모');
    expect(row).toContain('localhost');
  });

  it('hover하면 강조가 생기고 클릭하면 대상 카드·첨부 카드·기본 검사가 보인다', async () => {
    await startPicking(panel);
    const point = await center(page, '.seller-name');
    await page.mouse.move(point.x, point.y);
    await sleep(100);
    expect(await overlayPresent(page)).toBe(true);
    await page.mouse.click(point.x, point.y);
    await panel.waitForSelector('.attach-card');
    expect(await text(panel, '.target-label')).toBe('div.seller-name');
    expect(await text(panel, '.attach-card')).toContain('display: block');
    const findings = await text(panel, '.draft-findings');
    expect(findings).toContain('flex 항목');
    expect(findings).toContain('min-width: auto');
  });

  it('강조가 끝나면 오버레이를 문서에서 뺀다', async () => {
    await page.waitForFunction(() => !document.querySelector('noodlelens-overlay'), { timeout: 5000 });
  });

  it('선택 중 링크를 눌러도 이동하지 않고 링크 요소가 선택된다', async () => {
    const before = page.url();
    await pick(panel, page, '.nav-link');
    expect(page.url()).toBe(before);
    expect(await text(panel, '.target-label')).toBe('a.nav-link');
  });

  it('Esc로 취소하면 선택 모드와 오버레이가 정리되고 페이지 Escape 처리도 막는다', async () => {
    await page.evaluate(() => {
      (window as unknown as { escapes: number }).escapes = 0;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') (window as unknown as { escapes: number }).escapes += 1;
      });
    });
    await startPicking(panel);
    const point = await center(page, '.ok-title');
    await page.mouse.move(point.x, point.y);
    await page.keyboard.press('Escape');
    await panel.waitForFunction(() => !document.querySelector('.picking-banner'), { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('noodlelens-overlay'), { timeout: 3000 });
    expect(await page.evaluate(() => (window as unknown as { escapes: number }).escapes)).toBe(0);
    // 선택 모드가 끝났으므로 페이지 클릭은 다시 페이지로 간다.
    await page.click('#remove-btn');
    expect(await page.$('#removable')).toBeNull();
    await page.reload();
  });

  it('입력값·비밀번호는 수집하지 않는다', async () => {
    // 새로 고친 문서에서 다시 시작
    await pick(panel, page, 'form.login');
    const sent = await payload();
    expect(sent).toContain('form.login');
    expect(sent).not.toContain('hunter2-secret');
    expect(sent).not.toContain('tester@example.com');
    expect(sent).toContain('수집 안 함');
  });

  it('↑ 키로 부모 요소를 고를 수 있다', async () => {
    await startPicking(panel);
    const point = await center(page, '.seller-name');
    await page.mouse.move(point.x, point.y);
    await sleep(80);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await panel.waitForFunction(() => document.querySelector('.target-label')?.textContent === 'div.seller-body', { timeout: 5000 });
  });

  it('open shadow root 안쪽 요소까지 선택하고 한계를 표시한다', async () => {
    await page.evaluate(() => document.querySelector('shadow-card')?.scrollIntoView({ block: 'center' }));
    await startPicking(panel);
    const point = await page.evaluate(() => {
      const host = document.querySelector('shadow-card')!;
      const inner = host.shadowRoot!.querySelector('.badge-b')!;
      const r = inner.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await sleep(80);
    await page.mouse.click(point.x, point.y);
    await panel.waitForFunction(() => document.querySelector('.target-label')?.textContent === 'span.badge-b', { timeout: 5000 });
    expect(await payload()).toContain('open shadow root 안의 요소');
  });

  it('페이지가 넘치면 원인 후보(넘침 요소)를 수집한다', async () => {
    await pick(panel, page, '.ok-title');
    const sent = await payload();
    expect(sent).toContain('페이지 가로 넘침 후보');
    expect(sent).toContain('div.promo-strip');
  });

  it('근거 칩을 누르면 페이지에서 해당 요소를 강조한다', async () => {
    await panel.click('.draft-findings .cite');
    await page.waitForFunction(() => Boolean(document.querySelector('noodlelens-overlay')), { timeout: 3000 });
  });

  it('선택한 요소가 사라지면 페이지에서 보기에서 찾을 수 없다고 알린다', async () => {
    await pick(panel, page, '#removable');
    await page.click('#remove-btn');
    await panel.click('.attach-card-actions .chip-btn:nth-child(1)');
    await panel.waitForFunction(() => document.querySelector('.toasts')?.textContent?.includes('더 이상 페이지에 없습니다'), { timeout: 5000 });
    expect(await text(panel, '.live')).toContain('요소가 사라짐');
  });

  it('페이지를 이동하면 수집한 요소는 페이지 이동됨으로 표시한다', async () => {
    await pick(panel, page, '.ok-title');
    await page.goto(`${env.origin}/?moved=1`);
    await panel.waitForFunction(() => document.querySelector('.live')?.textContent?.includes('페이지 이동됨'), { timeout: 5000 });
    await panel.click('.attach-card-actions .chip-btn:nth-child(1)');
    await panel.waitForFunction(() => document.querySelector('.toasts')?.textContent?.includes('찾을 수 없습니다'), { timeout: 5000 });
  });

  it('같은 출처로 이동한 문서는 activeTab이 유지되어 다시 선택할 수 있다', async () => {
    await pick(panel, page, '.ok-title');
    expect(await text(panel, '.target-label')).toBe('div.ok-title');
  });

  it('아이콘을 누르지 않은 새 탭은 접근 권한이 없다고 안내한다', async () => {
    const other = await env.browser.newPage();
    await other.goto(`http://127.0.0.1:${new URL(env.origin).port}/`);
    await other.bringToFront();
    await panel.waitForFunction(() => document.querySelector('.page-row')?.textContent?.includes('접근 권한이 없습니다'), { timeout: 5000 });
    await panel.click('.composer-row .btn-secondary');
    await panel.waitForFunction(() => document.querySelector('.toasts')?.textContent?.includes('툴바의 NoodleLens 아이콘'), { timeout: 5000 });
    // 아이콘을 누르면 그 탭에 activeTab이 생긴다.
    await openPanel(env, other);
    await panel.waitForFunction(() => !document.querySelector('.page-row')?.textContent?.includes('접근 권한이 없습니다'), { timeout: 5000 });
    await pick(panel, other, '.ok-title');
    expect(await text(panel, '.target-label')).toBe('div.ok-title');
    await other.close();
  });
});
