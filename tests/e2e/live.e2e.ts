/**
 * 실제 API E2E (네트워크 필요).
 * - 무효한 가짜 키: 실제 OpenAI·Anthropic 서버에 요청해 CORS 통과와 실제 401 처리를 확인한다(인증 단계 거절이라 과금 없음).
 * - 실제 키(.env.local에 있을 때만): 실제 모델 스트리밍 응답을 끝까지 받는다. 키는 저장소에 직접 넣고 출력하지 않는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptConsent,
  askAndWaitStart,
  chooseModel,
  lastAnswer,
  launch,
  openDemo,
  openPanel,
  pick,
  readDb,
  waitForAnswer,
  type Env,
} from './harness';

function envLocal(): Record<string, string> {
  const file = join(import.meta.dirname, '..', '..', '.env.local');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const keys = envLocal();
let env: Env;
let page: Page;
let panel: Page;

/** 키를 세션 저장소(chrome.storage.session)에 직접 넣는다. 화면 입력란을 거치지 않는다. */
async function seedKey(provider: 'anthropic' | 'openai', apiKey: string) {
  await panel.evaluate(
    async (p, k) => {
      await chrome.storage.session.set({ [`nl.key.${p}`]: { apiKey: k, savedAt: Date.now() } });
    },
    provider,
    apiKey,
  );
  await panel.reload();
  await panel.waitForSelector('.composer', { timeout: 8000 });
}

beforeAll(async () => {
  env = await launch();
  page = await openDemo(env);
  panel = await openPanel(env, page);
  await acceptConsent(panel);
});

afterAll(async () => {
  await env?.close();
});

describe('실제 API — 무효한 키', () => {
  it('Anthropic 실제 서버가 401을 주면 인증 오류로 안내한다(CORS 통과)', async () => {
    await seedKey('anthropic', 'sk-ant-api03-invalid-e2e-key-000000000000');
    await pick(panel, page, '.notice-title');
    await askAndWaitStart(panel, '실제 401 확인').catch(() => {});
    await waitForAnswer(panel, 'error', 30000);
    const answer = await lastAnswer(panel);
    expect(answer.notice).toContain('API 키가 올바르지 않거나');
    expect(answer.notice).toContain('authentication_error');
    expect(answer.notice).not.toContain('invalid-e2e-key-000000000000');
  });

  it('OpenAI 실제 서버가 401을 주면 인증 오류로 안내한다(CORS 통과)', async () => {
    await seedKey('openai', 'sk-proj-invalid-e2e-key-0000000000000000');
    panel.once('dialog', (dialog) => void dialog.accept());
    await chooseModel(panel, 'GPT-6.1 Sol');
    await panel.waitForSelector('.attach-row', { timeout: 8000 }).catch(() => pick(panel, page, '.notice-title'));
    await askAndWaitStart(panel, '실제 401 확인').catch(() => {});
    await waitForAnswer(panel, 'error', 30000);
    const answer = await lastAnswer(panel);
    expect(answer.notice).toContain('API 키가 올바르지 않거나');
    expect(answer.notice).not.toContain('invalid-e2e-key-0000000000000000');
  });
});

describe.skipIf(!keys.ANTHROPIC_API_KEY)('실제 API — Anthropic 실제 키', () => {
  it('Claude Sonnet 5.5에서 스트리밍 답변을 끝까지 받고 근거 식별자를 확인한다', async () => {
    await seedKey('anthropic', keys.ANTHROPIC_API_KEY!);
    panel.once('dialog', (dialog) => void dialog.accept());
    await chooseModel(panel, 'Claude Sonnet 5.5');
    await panel.waitForSelector('.attach-row', { timeout: 8000 }).catch(() => pick(panel, page, '.seller-name'));
    await askAndWaitStart(panel, '이 텍스트가 왜 말줄임되지 않을까?');
    await panel.waitForSelector('.msg-assistant.status-streaming', { timeout: 60000 });
    await waitForAnswer(panel, 'complete', 180000);
    const answer = await lastAnswer(panel);
    expect(answer.text.length).toBeGreaterThan(100);
    expect(answer.foot).toContain('입력');
    const db = await readDb(panel);
    const saved = db.messages.filter((m) => m.role === 'assistant' && m.status === 'complete' && m.provider === 'anthropic').at(-1);
    expect(saved?.usage).toBeTruthy();
    console.log('[live anthropic]', JSON.stringify({ chars: answer.text.length, foot: answer.foot }));
  }, 240000);
});

describe.skipIf(!keys.OPENAI_API_KEY)('실제 API — OpenAI 실제 키', () => {
  it('GPT-6.1 Sol에서 스트리밍 답변을 끝까지 받는다', async () => {
    await seedKey('openai', keys.OPENAI_API_KEY!);
    panel.once('dialog', (dialog) => void dialog.accept());
    await chooseModel(panel, 'GPT-6.1 Sol');
    await panel.waitForSelector('.attach-row', { timeout: 8000 }).catch(() => pick(panel, page, '.seller-name'));
    await askAndWaitStart(panel, '이 텍스트가 왜 말줄임되지 않을까?');
    await waitForAnswer(panel, 'complete', 180000);
    const answer = await lastAnswer(panel);
    expect(answer.text.length).toBeGreaterThan(100);
    console.log('[live openai]', JSON.stringify({ chars: answer.text.length, foot: answer.foot }));
  }, 240000);
});
