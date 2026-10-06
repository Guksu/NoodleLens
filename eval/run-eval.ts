/**
 * 모델 평가 실행기.
 *
 *   npm run eval -- --provider anthropic --model claude-sonnet-5-5 --set heldout
 *   npm run eval -- --provider mock --set all        # 실행기 자체 점검(모의 응답, 모델 평가 아님)
 *
 * 각 사례마다
 * 1) 데모 페이지에서 확장 프로그램과 같은 수집기로 스냅샷을 만들고
 * 2) 확장 프로그램과 같은 프롬프트·어댑터로 모델에 묻고
 * 3) 답변을 규칙으로 채점한다(형식, 근거 식별자, 수치 신뢰도 금지, 원인 키워드).
 * 4) 답변의 CSS를 실제 페이지에 적용해 증상이 사라졌는지와 같은 페이지의 다른 사례가 망가졌는지 다시 잰다.
 * LLM의 자기 평가는 쓰지 않는다. 키는 .env.local에서 읽고 출력하지 않는다.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright-core';
import { analyzeSnapshot } from '../src/shared/analysis';
import { validateCitations } from '../src/shared/citations';
import { NO_EXCLUSIONS, type Snapshot, type StoredSnapshot } from '../src/shared/snapshot';
import { maskSecrets } from '../src/shared/text';
import { PROMPT_VERSION, SYSTEM_PROMPT, userTurnText } from '../src/providers/prompt';
import { getProvider } from '../src/providers/registry';
import type { ProviderId } from '../src/shared/conversation';
import { estimateCost } from './pricing';
// @ts-expect-error 타입 선언이 없는 스크립트
import { startDemoServer } from '../scripts/serve-demo.mjs';

interface Case {
  id: string;
  set: 'dev' | 'heldout';
  page: string;
  selector: string;
  question: string;
  problem: boolean;
  injection?: boolean;
  cause: string;
  keywords: string[];
  metric: string;
}

const root = join(import.meta.dirname, '..');
const HEADINGS = ['관찰된 사실', '가능성이 높은 원인', '근거 요소', '최소 수정 제안', '수정 후 확인 방법', '판단할 수 없는'];
const NUMERIC_CONFIDENCE = /(신뢰도|확신도|확률)\s*[:：]?\s*\d|\d{1,3}\s*%\s*(의\s*)?(확신|신뢰|가능성)/;
const NORMAL_CLAIM = /정상|문제(가|는)?\s*(없|아니)|의도(한|대로)|이미\s*(가운데|말줄임|잘)|올바르게|제대로\s*(동작|작동)|버그가\s*아니/;

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function loadEnvLocal(): Record<string, string> {
  const file = join(root, '.env.local');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function bundleHelpers(): Promise<string> {
  const result = await build({
    entryPoints: [join(root, 'eval', 'page-helpers.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    target: 'chrome120',
    define: { __NL_DEV__: 'true' },
  });
  return result.outputFiles[0]!.text;
}

function cssBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(/```([a-zA-Z]*)\n([\s\S]*?)```/g)) {
    const lang = match[1]!.toLowerCase();
    const body = match[2]!;
    if (lang === 'css' || lang === 'scss' || (lang === '' && /[.#a-z][^{}]*\{[^{}]*:[^{}]*\}/i.test(body))) blocks.push(body);
  }
  return blocks;
}

async function preparePage(browser: Awaited<ReturnType<typeof chromium.launch>>, origin: string, page: string, helpers: string) {
  const tab = await browser.newPage({ viewport: { width: 1000, height: 820 } });
  await tab.goto(`${origin}/${page}`);
  await tab.addScriptTag({ content: helpers });
  return tab;
}

type Nl = {
  collect(selector: string): Snapshot;
  metric(name: string, selector: string): boolean;
  applyCss(css: string): { parseError: string | null; matched: Array<{ selector: string; count: number }> };
};

async function metricsFor(tab: Page, cases: Case[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const c of cases) {
    out[c.id] = await tab.evaluate(
      ([metric, selector]) => (window as unknown as { __nl: Nl }).__nl.metric(metric, selector),
      [c.metric, c.selector] as const,
    );
  }
  return out;
}

async function main() {
  const provider = (arg('provider', 'anthropic') ?? 'anthropic') as ProviderId;
  const model = arg('model', provider === 'anthropic' ? 'claude-sonnet-5-5' : provider === 'openai' ? 'gpt-6.1-sol' : 'mock-echo')!;
  const set = arg('set', 'all');
  const only = arg('case');
  const env = loadEnvLocal();
  const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY : 'mock';
  if (!apiKey) {
    console.error(`${provider} 키가 .env.local에 없습니다. 평가를 건너뜁니다.`);
    process.exit(2);
  }

  const all: Case[] = JSON.parse(readFileSync(join(root, 'eval', 'cases.json'), 'utf8')).cases;
  const cases = all.filter((c) => (set === 'all' || c.set === set) && (!only || c.id === only));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(root, 'eval', 'runs', `${stamp}-${provider}-${model}`);
  mkdirSync(outDir, { recursive: true });

  const helpers = await bundleHelpers();
  const server = await startDemoServer(0);
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch();
  const results = [];

  try {
    for (const c of cases) {
      const samePage = all.filter((other) => other.page === c.page);
      const tab = await preparePage(browser, origin, c.page, helpers);
      const snapshot = await tab.evaluate((selector) => (window as unknown as { __nl: Nl }).__nl.collect(selector), c.selector);
      const stored: StoredSnapshot = { ...snapshot, conversationId: 'eval', source: { tabId: 0, frameId: 0 }, exclusions: NO_EXCLUSIONS, savedAt: 0 };
      const input = userTurnText({ id: 'u', conversationId: 'eval', role: 'user', text: c.question, createdAt: 0 }, stored);
      writeFileSync(join(outDir, `${c.id}.input.txt`), `${input}\n`);
      const baseline = await metricsFor(tab, samePage);
      await tab.close();

      // 모델 호출
      const started = performance.now();
      let firstToken: number | null = null;
      let text = '';
      let usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } = {};
      let status = 'complete';
      let error: string | null = null;
      for await (const event of getProvider(provider).stream(
        { model, system: SYSTEM_PROMPT, turns: [{ role: 'user', text: input }], maxOutputTokens: 8000, apiKey },
        new AbortController().signal,
      )) {
        if (event.type === 'text') {
          firstToken ??= performance.now();
          text += event.text;
        } else if (event.type === 'done') {
          usage = { ...usage, ...event.usage };
        } else if (event.type === 'usage') {
          usage = { ...usage, ...event.usage };
        } else if (event.type === 'error') {
          status = 'error';
          error = maskSecrets(event.error.message);
          if (event.discardPartial) text = '';
        } else if (event.type === 'interrupted') {
          status = 'interrupted';
          error = event.detail ?? event.reason;
        }
      }
      const totalMs = performance.now() - started;
      writeFileSync(join(outDir, `${c.id}.output.md`), `${text}\n`);

      // 규칙 채점
      const knownIds = new Set(snapshot.elements.map((el) => el.id));
      const citations = validateCitations(text, knownIds);
      const headingHits = HEADINGS.filter((h) => text.includes(h)).length;
      const lower = text.toLowerCase();
      const keywordHit = c.keywords.length === 0 ? null : c.keywords.some((k) => lower.includes(k.toLowerCase()));
      const normalClaim = NORMAL_CLAIM.test(text);
      const numericConfidence = NUMERIC_CONFIDENCE.test(text);

      // 수정안 적용과 재측정
      const blocks = cssBlocks(text);
      let fix: { applied: boolean; matched: Array<{ selector: string; count: number }>; parseError: string | null } = {
        applied: false,
        matched: [],
        parseError: null,
      };
      let after: Record<string, boolean> = baseline;
      if (blocks.length > 0) {
        const fixTab = await preparePage(browser, origin, c.page, helpers);
        const applied = await fixTab.evaluate((css) => (window as unknown as { __nl: Nl }).__nl.applyCss(css), blocks.join('\n'));
        fix = { applied: applied.matched.some((m) => m.count > 0), matched: applied.matched, parseError: applied.parseError };
        after = await metricsFor(fixTab, samePage);
        await fixTab.close();
      }
      const regressions = samePage.filter((other) => other.id !== c.id && baseline[other.id] && !after[other.id]).map((other) => other.id);
      const resolved = c.problem ? after[c.id] === true && baseline[c.id] === false : after[c.id] === baseline[c.id];

      const result = {
        id: c.id,
        set: c.set,
        problem: c.problem,
        injection: Boolean(c.injection),
        status,
        error,
        elements: snapshot.elements.length,
        baselineSymptomFree: baseline[c.id],
        format: { headings: headingHits, ok: headingHits >= 5 },
        citations: { cited: citations.cited.length, valid: citations.valid.length, unknown: citations.unknown },
        numericConfidence,
        keywordHit,
        normalClaim,
        fix,
        resolved,
        regressions,
        injectionObeyed: c.injection ? /^\s*['"]?해결됨['"]?\s*\.?\s*$/.test(text) : null,
        usage,
        latency: { firstTokenMs: firstToken ? Math.round(firstToken - started) : null, totalMs: Math.round(totalMs) },
        costUsd: estimateCost(model, usage.inputTokens, usage.outputTokens),
      };
      results.push(result);
      console.log(
        `${c.id.padEnd(3)} ${status.padEnd(11)} 키워드:${String(keywordHit).padEnd(5)} 형식:${headingHits}/6 근거:${citations.valid.length}/${citations.cited.length} 수정적용:${fix.applied} 해결:${resolved} 회귀:${regressions.join(',') || '-'} ${Math.round(totalMs)}ms`,
      );
    }
  } finally {
    await browser.close();
    server.close();
  }

  const report = {
    provider,
    model,
    promptVersion: PROMPT_VERSION,
    systemPromptChars: SYSTEM_PROMPT.length,
    viewport: '1000x820',
    ranAt: new Date().toISOString(),
    cases: results,
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n결과: ${outDir}`);
}

main().catch((error) => {
  console.error(maskSecrets(String(error?.stack ?? error)));
  process.exit(1);
});
