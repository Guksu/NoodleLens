import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, ANTHROPIC_URL, buildAnthropicBody } from '../../src/providers/anthropic';
import { OpenAiProvider, OPENAI_URL, buildOpenAiBody } from '../../src/providers/openai';
import type { ChatRequest, StreamEvent } from '../../src/providers/types';
import { brokenSseResponse, collect, sse, sseResponse } from './fixtures';

const request: ChatRequest = {
  model: 'test-model',
  system: 'SYSTEM',
  turns: [
    { role: 'user', text: '질문 1' },
    { role: 'assistant', text: '답 1' },
    { role: 'user', text: '질문 2' },
  ],
  maxOutputTokens: 1000,
  apiKey: 'sk-ant-api03-SECRETSECRETSECRET',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const texts = (events: StreamEvent[]) => events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');

describe('Anthropic 어댑터', () => {
  it('브라우저 직접 호출 헤더와 본문을 만든다', async () => {
    const fetchMock = vi.fn(async () => sseResponse([sse('message_stop', { type: 'message_stop' })]));
    await collect(new AnthropicProvider(fetchMock).stream(request, new AbortController().signal));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe(request.apiKey);
    expect(JSON.parse(String(init.body))).toEqual(buildAnthropicBody(request));
    expect(buildAnthropicBody(request).messages).toHaveLength(3);
  });

  it('thinking 블록이 먼저 와도 텍스트만 모으고 사용량을 읽는다', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 120 } } }),
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }),
        sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '안녕' } }),
        'event: ping\ndata: {"type":"ping"}\n\n',
        sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '하세요' } }),
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
        sse('message_stop', { type: 'message_stop' }),
      ]),
    );
    const events = await collect(new AnthropicProvider(fetchMock).stream(request, new AbortController().signal));
    expect(texts(events)).toBe('안녕하세요');
    expect(events).toContainEqual({ type: 'status', phase: 'thinking' });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 42 } });
  });

  it('401은 인증 오류로, 오류 문구 속 키는 가린다', async () => {
    const fetchMock = vi.fn(async () =>
      json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-api03-SECRETSECRETSECRET' } }),
    );
    const events = await collect(new AnthropicProvider(fetchMock).stream(request, new AbortController().signal));
    expect(events).toHaveLength(1);
    const error = (events[0] as Extract<StreamEvent, { type: 'error' }>).error;
    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('SECRETSECRET');
  });

  it('429는 재시도 가능한 한도 오류이고 retry-after를 읽는다', async () => {
    const fetchMock = vi.fn(async () =>
      json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, { 'retry-after': '17' }),
    );
    const [event] = await collect(new AnthropicProvider(fetchMock).stream(request, new AbortController().signal));
    expect(event).toMatchObject({ type: 'error', error: { kind: 'rate_limit', retryable: true, retryAfterSec: 17, status: 429 } });
  });

  it('월 지출 상한 429는 재시도해도 소용없는 quota로 본다', async () => {
    const fetchMock = vi.fn(async () =>
      json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'limit', details: { error_code: 'enforced_spend_limit_reached' } } }),
    );
    const [event] = await collect(new AnthropicProvider(fetchMock).stream(request, new AbortController().signal));
    expect(event).toMatchObject({ type: 'error', error: { kind: 'quota', retryable: false } });
  });

  it('529와 스트림 중 overloaded 오류를 혼잡으로 분류한다', async () => {
    const overloaded = vi.fn(async () => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    const [first] = await collect(new AnthropicProvider(overloaded).stream(request, new AbortController().signal));
    expect(first).toMatchObject({ type: 'error', error: { kind: 'overloaded', retryable: true } });

    const midStream = vi.fn(async () =>
      sseResponse([
        sse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '부분' } }),
        sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      ]),
    );
    const events = await collect(new AnthropicProvider(midStream).stream(request, new AbortController().signal));
    expect(texts(events)).toBe('부분');
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'overloaded' } });
  });

  it('응답 도중 연결이 끊기면 interrupted(network)로 알리고 받은 텍스트는 남긴다', async () => {
    const fetchMock = vi.fn(async () =>
      brokenSseResponse([sse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '반쯤' } })]),
    );
    const events = await collect(new AnthropicProvider(fetchMock).stream(request, new AbortController().signal));
    expect(texts(events)).toBe('반쯤');
    expect(events.at(-1)).toMatchObject({ type: 'interrupted', reason: 'network' });
  });

  it('message_stop 없이 스트림이 닫히면 stream-ended로 알린다', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([sse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '끊김' } })]),
    );
    const events = await collect(new AnthropicProvider(fetchMock).stream(request, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: 'interrupted', reason: 'stream-ended' });
  });

  it('거절(refusal)이면 받은 부분을 버리라고 알린다', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        sse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } }),
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal' } }),
        sse('message_stop', { type: 'message_stop' }),
      ]),
    );
    const events = await collect(new AnthropicProvider(fetchMock).stream(request, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'error', discardPartial: true, error: { kind: 'refusal' } });
  });

  it('네트워크 실패(fetch 예외)는 응답 전 오류로, abort는 조용히 끝낸다', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const [event] = await collect(new AnthropicProvider(failing).stream(request, new AbortController().signal));
    expect(event).toMatchObject({ type: 'error', error: { kind: 'network', retryable: true } });

    const controller = new AbortController();
    controller.abort();
    const aborted = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    expect(await collect(new AnthropicProvider(aborted).stream(request, controller.signal))).toEqual([]);
  });
});

describe('OpenAI 어댑터', () => {
  it('Responses API 본문(store:false, instructions, input)을 만든다', async () => {
    const fetchMock = vi.fn(async () => sseResponse([sse('response.completed', { type: 'response.completed', response: { usage: {} } })]));
    await collect(new OpenAiProvider(fetchMock).stream(request, new AbortController().signal));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENAI_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${request.apiKey}`);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual(buildOpenAiBody(request));
    expect(body.store).toBe(false);
    expect(body.instructions).toBe('SYSTEM');
    expect(body.input[1]).toEqual({ role: 'assistant', content: '답 1' });
  });

  it('텍스트 델타와 완료 사용량(추론 토큰 포함)을 읽는다', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        sse('response.created', { type: 'response.created' }),
        sse('response.output_item.added', { type: 'response.output_item.added', item: { type: 'reasoning' } }),
        sse('response.output_item.added', { type: 'response.output_item.added', item: { type: 'message' } }),
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '가로 ' }),
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '넘침' }),
        sse('response.completed', {
          type: 'response.completed',
          response: { usage: { input_tokens: 900, output_tokens: 300, output_tokens_details: { reasoning_tokens: 120 } } },
        }),
      ]),
    );
    const events = await collect(new OpenAiProvider(fetchMock).stream(request, new AbortController().signal));
    expect(texts(events)).toBe('가로 넘침');
    expect(events).toContainEqual({ type: 'status', phase: 'thinking' });
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'completed',
      usage: { inputTokens: 900, outputTokens: 300, reasoningTokens: 120 },
    });
  });

  it('insufficient_quota 429와 일반 429를 구분한다', async () => {
    const quota = vi.fn(async () =>
      json(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'credit_balance_exhausted' } }),
    );
    const [quotaEvent] = await collect(new OpenAiProvider(quota).stream(request, new AbortController().signal));
    expect(quotaEvent).toMatchObject({ type: 'error', error: { kind: 'quota', retryable: false } });

    const rate = vi.fn(async () => json(429, { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }));
    const [rateEvent] = await collect(new OpenAiProvider(rate).stream(request, new AbortController().signal));
    expect(rateEvent).toMatchObject({ type: 'error', error: { kind: 'rate_limit', retryable: true } });
  });

  it('잘못된 키(401) 메시지의 키 일부를 가린다', async () => {
    const fetchMock = vi.fn(async () =>
      json(401, { error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop1234. You can find your API key at ...', type: 'invalid_request_error', code: 'invalid_api_key' } }),
    );
    const [event] = await collect(new OpenAiProvider(fetchMock).stream(request, new AbortController().signal));
    const error = (event as Extract<StreamEvent, { type: 'error' }>).error;
    expect(error.kind).toBe('auth');
    expect(error.message).not.toContain('abcdefghijklmnop1234');
  });

  it('response.failed와 incomplete(max_output_tokens)를 처리한다', async () => {
    const failed = vi.fn(async () =>
      sseResponse([sse('response.failed', { type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } })]),
    );
    const [failedEvent] = (await collect(new OpenAiProvider(failed).stream(request, new AbortController().signal))).slice(-1);
    expect(failedEvent).toMatchObject({ type: 'error', error: { kind: 'server' } });

    const incomplete = vi.fn(async () =>
      sseResponse([
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '긴 답' }),
        sse('response.incomplete', { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 1000 } } }),
      ]),
    );
    const events = await collect(new OpenAiProvider(incomplete).stream(request, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_tokens' });
  });

  it('completed 없이 닫힌 스트림은 interrupted(stream-ended)다', async () => {
    const fetchMock = vi.fn(async () => sseResponse([sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '부분' })]));
    const events = await collect(new OpenAiProvider(fetchMock).stream(request, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: 'interrupted', reason: 'stream-ended' });
  });
});
