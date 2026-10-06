/**
 * 개발용 모의 제공자. 네트워크를 쓰지 않고 규칙 검사 결과를 그대로 나열하는 응답을 흉내 낸다.
 * 화면·상태 처리 확인용이며 실제 모델 응답이 아니다. 모든 응답 첫 줄에 모의 응답임을 밝힌다.
 *
 * 질문에 다음 지시어를 넣으면 오류 상황을 재현한다.
 * #mock:auth  #mock:rate-limit  #mock:quota  #mock:network  #mock:network-mid  #mock:overloaded-mid  #mock:slow
 */
import { makeError } from './errors';
import type { ChatProvider, ChatRequest, StreamEvent } from './types';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function composeMockAnswer(request: ChatRequest): string {
  const last = request.turns.at(-1)?.text ?? '';
  const checks = /<rule_checks>\n([\s\S]*?)\n<\/rule_checks>/.exec(last)?.[1] ?? '';
  const target = /\[(E\d+)\] 대상:/.exec(last)?.[1];
  const ids = [...new Set([...last.matchAll(/^\[(E\d+)\]/gm)].map((m) => m[1]))].slice(0, 4);
  const facts = checks
    .split('\n')
    .filter((line) => /^- \[(측정 사실|CSS 조건|정상)\]/.test(line))
    .slice(0, 6);
  const hints = checks
    .split('\n')
    .filter((line) => /^- \[가능성\]/.test(line))
    .slice(0, 3);
  return [
    '> **모의 응답입니다.** 실제 모델이 만든 내용이 아니며, 규칙 검사 결과를 옮겨 적었습니다.',
    '',
    '### 관찰된 사실',
    ...(facts.length ? facts : ['- (이번 질문에 첨부된 규칙 검사 결과가 없습니다)']),
    '',
    '### 가능성이 높은 원인',
    ...(hints.length ? hints : ['- 모의 응답은 원인을 추론하지 않습니다.']),
    '',
    '### 근거 요소·스타일',
    ids.length ? `- ${ids.map((id) => `[${id}]`).join(', ')}${target ? ` (대상: [${target}])` : ''}` : '- (수집된 요소 없음)',
    '- 존재하지 않는 식별자 표시 확인용: [E999]',
    '',
    '### 최소 수정 제안',
    '```css',
    '/* 모의 응답: 실제 수정 제안이 아닙니다 */',
    '.example { min-width: 0; }',
    '```',
    '',
    '### 수정 후 확인 방법',
    '- DevTools 콘솔: `document.documentElement.scrollWidth > document.documentElement.clientWidth`',
    '',
    '### 현재 자료로 판단할 수 없는 부분',
    '- 모의 응답이라 판단하지 않았습니다.',
  ].join('\n');
}

export class MockProvider implements ChatProvider {
  readonly id = 'mock' as const;

  constructor(private readonly chunkDelayMs = 16) {}

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const last = request.turns.at(-1)?.text ?? '';
    const directive = /#mock:([a-z-]+)/.exec(last)?.[1];
    await sleep(directive === 'slow' ? 1200 : 120, signal);
    if (signal.aborted) return;
    if (directive === 'auth') {
      yield { type: 'error', error: makeError('auth', '401 · authentication_error · (모의)', { status: 401 }) };
      return;
    }
    if (directive === 'rate-limit') {
      yield { type: 'error', error: makeError('rate_limit', '429 · rate_limit_error · (모의)', { status: 429, retryAfterSec: 20 }) };
      return;
    }
    if (directive === 'quota') {
      yield { type: 'error', error: { ...makeError('quota', '429 · insufficient_quota · (모의)', { status: 429 }), retryable: false } };
      return;
    }
    if (directive === 'network') {
      yield { type: 'error', error: makeError('network', 'Failed to fetch (모의)') };
      return;
    }
    yield { type: 'status', phase: 'connected' };
    yield { type: 'status', phase: 'writing' };
    const answer = composeMockAnswer(request);
    const chunks = answer.match(/[\s\S]{1,14}/g) ?? [];
    const delay = directive === 'slow' ? this.chunkDelayMs * 4 : this.chunkDelayMs;
    for (let i = 0; i < chunks.length; i += 1) {
      await sleep(delay, signal);
      if (signal.aborted) return;
      yield { type: 'text', text: chunks[i] ?? '' };
      if (i === 24 && directive === 'network-mid') {
        yield { type: 'interrupted', reason: 'network', detail: 'network error (모의)' };
        return;
      }
      if (i === 24 && directive === 'overloaded-mid') {
        yield { type: 'error', error: makeError('overloaded', 'overloaded_error · (모의)') };
        return;
      }
    }
    yield {
      type: 'done',
      stopReason: 'end_turn',
      usage: { inputTokens: Math.ceil(request.turns.map((t) => t.text).join('').length / 3), outputTokens: Math.ceil(answer.length / 2) },
    };
  }
}
