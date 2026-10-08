/**
 * 제공자 어댑터 E2E. 실제 확장 프로그램 패널이 보내는 요청을 가로채 정해 둔 응답을 돌려준다.
 * 실제 API에 연결한 결과가 아니다(실제 연결은 live.e2e.ts에서 키가 있을 때만 확인).
 * 키 입력란에는 형식만 맞춘 가짜 시험 값을 넣는다.
 */
import type { HTTPRequest, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptConsent,
  ask,
  askAndWaitStart,
  chooseModel,
  lastAnswer,
  launch,
  openDemo,
  openPanel,
  pick,
  waitForAnswer,
  type Env,
} from './harness';

const FAKE_ANTHROPIC_KEY = 'sk-ant-e2e-fake-key-0001';
const FAKE_OPENAI_KEY = 'sk-e2e-fake-key-0002';

type Responder = (request: HTTPRequest) => Promise<void> | void;

let env: Env;
let page: Page;
let panel: Page;
let responder: Responder | null = null;
const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': '*',
};

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function saveKey(provider: 'anthropic' | 'openai', key: string) {
  await panel.click('.header-actions .icon-btn:nth-child(3)');
  await panel.waitForSelector('.key-card');
  const cards = await panel.$$('.key-card');
  const card = provider === 'anthropic' ? cards[0]! : cards[1]!;
  const input = (await card.$('input[type="password"]'))!;
  await input.click({ count: 3 });
  await input.type(key);
  await (await card.$('button[type="submit"]'))!.click();
  await panel.waitForFunction(
    (index) => document.querySelectorAll('.key-card')[index]?.querySelector('.badge-ok') !== null,
    { timeout: 5000 },
    provider === 'anthropic' ? 0 : 1,
  );
  await panel.click('.header-actions .icon-btn:nth-child(3)');
  await panel.waitForSelector('.composer');
}

beforeAll(async () => {
  env = await launch();
  page = await openDemo(env);
  panel = await openPanel(env, page);
  await acceptConsent(panel);
  await panel.setRequestInterception(true);
  panel.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('https://api.anthropic.com/') && !url.startsWith('https://api.openai.com/')) {
      void request.continue();
      return;
    }
    if (request.method() === 'OPTIONS') {
      void request.respond({ status: 204, headers: { ...CORS, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
      return;
    }
    seen.push({ url, headers: request.headers(), body: request.postData() ?? '' });
    if (responder) void responder(request);
    else void request.abort('failed');
  });
  await pick(panel, page, '.notice-title');
});

afterAll(async () => {
  await env?.close();
});

describe('Anthropic (가로챈 응답)', () => {
  it('키가 없으면 보내기가 막히고 키 입력을 안내한다(요청 없음)', async () => {
    const before = seen.length;
    await ask(panel, '키 없이 질문');
    expect(await panel.$eval('.send-btn', (el) => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(await panel.$eval('.composer-hint', (el) => el.textContent)).toContain('API 키가 필요합니다');
    expect(await panel.$$('.bubble')).toHaveLength(0);
    expect(seen.length).toBe(before);
    // 입력한 글은 남아 있다
    expect(await panel.$eval('.composer-input', (el) => (el as HTMLTextAreaElement).value)).toBe('키 없이 질문');
  });

  it('스트리밍 응답을 받아 완료하고 사용량을 표시한다', async () => {
    await saveKey('anthropic', FAKE_ANTHROPIC_KEY);
    responder = (request) =>
      request.respond({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: [
          sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 1530 } } }),
          sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '### 관찰된 사실\n- [E1]의 white-space가 normal입니다.' } }),
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 88 } }),
          sse('message_stop', { type: 'message_stop' }),
        ].join(''),
      });
    await askAndWaitStart(panel, '왜 말줄임이 안 될까?');
    await waitForAnswer(panel, 'complete');
    const answer = await lastAnswer(panel);
    expect(answer.text).toContain('white-space가 normal');
    expect(answer.foot).toContain('입력 1,530');
    expect(answer.foot).toContain('출력 88');
    const request = seen.at(-1)!;
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(request.headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
    const body = JSON.parse(request.body);
    expect(body.stream).toBe(true);
    expect(body.messages.at(-1).content).toContain('<page_snapshot');
    expect(body.messages.at(-1).content).toContain('질문: 왜 말줄임이 안 될까?');
    expect(body.system).toContain('식별자');
  });

  it('401은 키 확인 안내와 설정 버튼을 보여 주고 메시지 속 키를 가린다', async () => {
    responder = (request) =>
      request.respond({
        status: 401,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${FAKE_ANTHROPIC_KEY}` } }),
      });
    await askAndWaitStart(panel, '401 시험').catch(() => {});
    await waitForAnswer(panel, 'error');
    const answer = await lastAnswer(panel);
    expect(answer.notice).toContain('API 키가 올바르지 않거나');
    expect(answer.notice).not.toContain('fake-key-0001');
    expect(answer.notice).toContain('설정 열기');
  });

  it('429는 재시도 안내와 retry-after 초를 보여 준다', async () => {
    responder = (request) =>
      request.respond({
        status: 429,
        headers: { ...CORS, 'content-type': 'application/json', 'retry-after': '23' },
        body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }),
      });
    await askAndWaitStart(panel, '429 시험').catch(() => {});
    await waitForAnswer(panel, 'error');
    const answer = await lastAnswer(panel);
    expect(answer.notice).toContain('요청 한도');
    expect(answer.notice).toContain('23초');
    expect(answer.notice).toContain('다시 시도');
  });

  it('네트워크 실패는 연결 실패로 안내하고 다시 시도할 수 있다', async () => {
    responder = (request) => request.abort('internetdisconnected');
    await askAndWaitStart(panel, '네트워크 시험').catch(() => {});
    await waitForAnswer(panel, 'error');
    expect((await lastAnswer(panel)).notice).toContain('네트워크 연결에 실패');
    // 재시도하면 이번에는 성공한다
    responder = (request) =>
      request.respond({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: [
          sse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '재시도 성공' } }),
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
          sse('message_stop', { type: 'message_stop' }),
        ].join(''),
      });
    await panel.click('article.msg-assistant:last-of-type .msg-notice-actions .chip-btn');
    await waitForAnswer(panel, 'complete');
    expect((await lastAnswer(panel)).text).toContain('재시도 성공');
  });

  it('응답 도중 스트림이 끊기면 받은 부분을 남기고 연결 끊김으로 표시한다', async () => {
    responder = (request) =>
      request.respond({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: sse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '여기까지 받았' } }),
      });
    await askAndWaitStart(panel, '끊김 시험').catch(() => {});
    await waitForAnswer(panel, 'interrupted');
    const answer = await lastAnswer(panel);
    expect(answer.text).toContain('여기까지 받았');
    expect(answer.notice).toContain('응답이 끝나기 전에');
  });
});

describe('OpenAI (가로챈 응답)', () => {
  it('제공자를 바꾸면 새 분석으로 시작하고 기존 대화를 보내지 않는다', async () => {
    await saveKey('openai', FAKE_OPENAI_KEY);
    panel.once('dialog', (dialog) => void dialog.accept());
    await chooseModel(panel, 'GPT-6.1 Sol');
    // 대상 요소는 다시 수집해 첨부한다
    await panel.waitForSelector('.attach-row', { timeout: 5000 });
    expect(await panel.$$('.bubble')).toHaveLength(0);
  });

  it('Responses API 스트림을 받아 완료한다(store:false)', async () => {
    responder = (request) =>
      request.respond({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: [
          sse('response.created', { type: 'response.created' }),
          sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '### 관찰된 사실\n- [E1]은 ' }),
          sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '줄바꿈됩니다.' }),
          sse('response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1400, output_tokens: 60, output_tokens_details: { reasoning_tokens: 20 } } } }),
        ].join(''),
      });
    const before = seen.length;
    await askAndWaitStart(panel, 'GPT로 질문').catch(() => {});
    await waitForAnswer(panel, 'complete');
    const answer = await lastAnswer(panel);
    expect(answer.text).toContain('줄바꿈됩니다');
    expect(answer.foot).toContain('추론 20');
    const request = seen.at(-1)!;
    expect(seen.length).toBe(before + 1);
    expect(request.url).toBe('https://api.openai.com/v1/responses');
    expect(request.headers.authorization).toBe(`Bearer ${FAKE_OPENAI_KEY}`);
    const body = JSON.parse(request.body);
    expect(body.store).toBe(false);
    expect(body.model).toBe('gpt-6.1-sol');
    // 이전 Claude 대화 내용이 섞이지 않았다
    expect(JSON.stringify(body.input)).not.toContain('왜 말줄임이 안 될까?');
  });

  it('insufficient_quota는 결제·한도 확인을 안내한다', async () => {
    responder = (request) =>
      request.respond({
        status: 429,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }),
      });
    await askAndWaitStart(panel, '쿼터 시험').catch(() => {});
    await waitForAnswer(panel, 'error');
    expect((await lastAnswer(panel)).notice).toContain('크레딧이 없거나 지출 한도');
  });
});
