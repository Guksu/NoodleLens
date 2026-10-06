// 확장 프로그램 아이콘(PNG)을 SVG에서 만든다. 실행: node scripts/make-icons.mjs
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#17191f"/>
  <circle cx="14" cy="14" r="7.5" fill="none" stroke="#f2b544" stroke-width="2.6"/>
  <path d="M19.6 19.6 26 26" stroke="#f2b544" stroke-width="3" stroke-linecap="round"/>
  <path d="M9.2 14.6c1.2-1.9 2.4-1.9 3.2 0s2 1.9 3.2 0 2-1.9 3.2 0" fill="none" stroke="#fff4dc" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${SVG.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await writeFile(new URL(`../public/icons/icon-${size}.png`, import.meta.url), png);
}
await browser.close();
console.log('icons written');
