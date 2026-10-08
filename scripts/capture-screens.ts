/**
 * README·점검용 화면 캡처. 실제 사이드 패널을 열어 주요 상태를 찍는다(모의 제공자 사용).
 *   npm run build:dev && npx tsx scripts/capture-screens.ts [출력 폴더]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptConsent,
  askAndWaitStart,
  chooseModel,
  launch,
  openDemo,
  openPanel,
  pick,
  sleep,
  waitForAnswer,
  waitSheetSettled,
} from '../tests/e2e/harness';

const out = process.argv[2] ?? join(import.meta.dirname, '..', 'docs', 'images');
mkdirSync(out, { recursive: true });

const env = await launch();
try {
  const page = await openDemo(env, '/', { width: 1100, height: 820 });
  const panel = await openPanel(env, page);
  await panel.setViewport({ width: 380, height: 760 });
  const shot = async (name: string) => {
    await sleep(250);
    await panel.screenshot({ path: join(out, `${name}.png`) });
  };
  await shot('01-consent');
  await acceptConsent(panel);
  await shot('02-empty');
  await chooseModel(panel, '모의 응답');
  await pick(panel, page, '.seller-name');
  await shot('03-picked');
  await page.screenshot({ path: join(out, '03-page-highlight.png'), clip: { x: 0, y: 380, width: 700, height: 260 } }).catch(() => {});
  await askAndWaitStart(panel, '이 텍스트가 왜 말줄임되지 않을까?', 40);
  await shot('04-streaming');
  await waitForAnswer(panel, 'complete');
  await shot('05-answer');
  await panel.click('.msg-attachment .attach-chip');
  await panel.waitForSelector('.sheet');
  await waitSheetSettled(panel);
  await shot('06-preview');
  await panel.click('.sheet-head .icon-btn');
  await panel.waitForFunction(() => !document.querySelector('.sheet'));
  await askAndWaitStart(panel, '한도 오류 재현 #mock:rate-limit').catch(() => {});
  await waitForAnswer(panel, 'error');
  await shot('07-error');
  await panel.click('.header-actions .icon-btn:nth-child(2)');
  await panel.waitForSelector('.history-list');
  await shot('08-history');
  await panel.click('.header-actions .icon-btn:nth-child(3)');
  await panel.waitForSelector('.key-card');
  await shot('09-settings');
  await panel.click('.header-actions .icon-btn:nth-child(3)');
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await panel.evaluate(() => document.querySelector('.messages')?.scrollTo(0, 0));
  await shot('10-dark');
  await panel.setViewport({ width: 320, height: 700 });
  await shot('11-narrow-dark');
  console.log(`saved to ${out}`);
} finally {
  await env.close();
}
