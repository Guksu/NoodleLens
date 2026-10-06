/**
 * 평가 도구 자체 점검(모델 호출 없음). npm run eval:check
 * - 수정 전: 문제 사례는 증상이 있고, 정상 사례는 증상이 없어야 한다.
 * - 참조 수정안: 적용하면 '해결'로 판정되고 같은 페이지의 다른 사례를 망가뜨리지 않아야 한다.
 * - 불완전한 수정(음성 대조): '해결'로 판정되면 안 된다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
// @ts-expect-error 타입 선언이 없는 스크립트
import { startDemoServer } from '../scripts/serve-demo.mjs';

interface Case {
  id: string;
  page: string;
  selector: string;
  problem: boolean;
  metric: string;
}

const root = join(import.meta.dirname, '..');
const cases: Case[] = JSON.parse(readFileSync(join(root, 'eval', 'cases.json'), 'utf8')).cases;
const references: Record<string, string> = JSON.parse(readFileSync(join(root, 'eval', 'reference-fixes.json'), 'utf8'));

const NEGATIVE: Array<{ id: string; css: string; why: string }> = [
  { id: 'H1', css: '.article-main { min-width: 0; }', why: '열은 줄지만 긴 토큰이 칸 밖으로 넘쳐 여전히 가로로 넘친다' },
  { id: 'H2', css: '.file-name { min-width: 0; }', why: 'flex-shrink: 0이 남아 있어 줄지 않는다' },
  { id: 'B1', css: '.notice-title { overflow: hidden; }', why: '이미 hidden이고 white-space는 그대로다' },
  { id: 'C1', css: '.checkout-box { justify-content: center; }', why: 'column 방향에서 justify-content는 세로축이다' },
  { id: 'C2', css: '.footer-cta { text-align: center; }', why: 'block 요소는 text-align으로 옮겨지지 않는다' },
  { id: 'H4', css: '.subscribe-btn { margin: 0 auto; }', why: 'inline-block에는 auto 여백 가운데 정렬이 적용되지 않는다' },
];

type Nl = { metric(name: string, selector: string): boolean; applyCss(css: string): unknown };

const helpers = (
  await build({
    entryPoints: [join(root, 'eval', 'page-helpers.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    target: 'chrome120',
    define: { __NL_DEV__: 'true' },
  })
).outputFiles[0]!.text;
const server = await startDemoServer(0);
const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch();
let failures = 0;

async function measure(page: string, css: string | null) {
  const tab = await browser.newPage({ viewport: { width: 1000, height: 820 } });
  await tab.goto(`${origin}/${page}`);
  await tab.addScriptTag({ content: helpers });
  if (css) await tab.evaluate((c) => (window as unknown as { __nl: Nl }).__nl.applyCss(c), css);
  const out: Record<string, boolean> = {};
  for (const c of cases.filter((x) => x.page === page)) {
    out[c.id] = await tab.evaluate(([m, s]) => (window as unknown as { __nl: Nl }).__nl.metric(m, s), [c.metric, c.selector] as const);
  }
  await tab.close();
  return out;
}

function report(ok: boolean, line: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
}

try {
  const baselines: Record<string, Record<string, boolean>> = {};
  for (const page of [...new Set(cases.map((c) => c.page))]) baselines[page] = await measure(page, null);
  for (const c of cases) {
    const symptomFree = baselines[c.page]![c.id];
    report(symptomFree === !c.problem, `수정 전 ${c.id}: ${c.problem ? '증상 있음이어야 함' : '정상이어야 함'} (측정: ${symptomFree ? '증상 없음' : '증상 있음'})`);
  }
  for (const [id, css] of Object.entries(references)) {
    if (id.startsWith('$')) continue;
    const c = cases.find((x) => x.id === id)!;
    const after = await measure(c.page, css);
    const broken = Object.keys(after).filter((other) => other !== id && baselines[c.page]![other] && !after[other]);
    report(after[id] === true && broken.length === 0, `참조 수정 ${id}: 해결=${after[id]} 회귀=${broken.join(',') || '없음'}`);
  }
  for (const negative of NEGATIVE) {
    const c = cases.find((x) => x.id === negative.id)!;
    const after = await measure(c.page, negative.css);
    report(after[negative.id] === false, `불완전한 수정 ${negative.id} (${negative.css}): 해결로 보면 안 됨 — ${negative.why} (측정: ${after[negative.id] ? '해결' : '미해결'})`);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures === 0 ? '\n평가 도구 점검 통과' : `\n실패 ${failures}건`);
process.exit(failures === 0 ? 0 : 1);
