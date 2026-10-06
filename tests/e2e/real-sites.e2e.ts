/**
 * 실제 공개 사이트에서 요소 선택·수집이 되는지 확인한다(네트워크 필요, 기본 실행에서 제외).
 *   NL_REAL_SITES=1 npx vitest run -c vitest.e2e.config.ts tests/e2e/real-sites.e2e.ts
 * 읽기만 하며 사이트에 아무것도 입력하지 않는다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptConsent, launch, openPanel, pick, readDb, sleep, text, type Env } from './harness';

const SITES = [
  { name: 'GitHub 저장소 페이지(엄격한 CSP, React)', url: 'https://github.com/Guksu/NoodleLens', selector: 'main h1, main strong a, main a' },
  { name: 'MDN 문서(대형 문서 사이트)', url: 'https://developer.mozilla.org/ko/docs/Web/CSS/text-overflow', selector: 'main h1, h1' },
  { name: 'Hacker News(테이블 레이아웃)', url: 'https://news.ycombinator.com/', selector: '.titleline > a' },
  { name: '위키백과(긴 본문)', url: 'https://ko.wikipedia.org/wiki/CSS', selector: '#firstHeading' },
];

let env: Env;
beforeAll(async () => {
  env = await launch();
});
afterAll(async () => {
  await env?.close();
});

describe.skipIf(!process.env.NL_REAL_SITES)('실제 사이트', () => {
  for (const site of SITES) {
    it(site.name, async () => {
      const page = await env.browser.newPage();
      await page.setViewport({ width: 1100, height: 820 });
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);
      const selector = await page.evaluate((list) => list.split(',').map((s) => s.trim()).find((s) => document.querySelector(s)) ?? null, site.selector);
      expect(selector, '선택할 요소를 찾지 못함').not.toBeNull();
      const panel = await openPanel(env, page);
      await acceptConsent(panel);
      const started = Date.now();
      await pick(panel, page, selector!);
      const elapsed = Date.now() - started;
      const label = await text(panel, '.target-label');
      const meta = await text(panel, '.attach-card-meta');
      const findings = await text(panel, '.draft-findings .findings-summary').catch(() => '');
      await page.waitForFunction(() => !document.querySelector('noodlelens-overlay'), { timeout: 6000 });
      const db = await readDb(panel);
      console.log(`[real] ${site.name} | ${selector} → ${label} | ${meta} | 검사: ${findings || '-'} | ${elapsed}ms | 저장된 스냅샷 ${db.snapshots.length}`);
      expect(label.length).toBeGreaterThan(0);
      await page.close();
    }, 90000);
  }
});
