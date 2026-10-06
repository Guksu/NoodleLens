/**
 * Anthropic Messages API 어댑터 (POST /v1/messages, stream: true).
 *
 * 브라우저(확장 프로그램 페이지)에서 직접 부르므로 anthropic-dangerous-direct-browser-access 헤더가 필요하다.
 * 키는 사용자 본인 것이고 이 요청 외에는 어디에도 보내지 않는다.
 * Opus/Sonnet 5.5는 thinking 블록이 텍스트보다 먼저 올 수 있어 첫 블록을 텍스트로 가정하지 않는다.
 * 이전 답변은 텍스트만 다시 보내고 thinking 블록은 보내지 않는다.
 */
import type { Usage } from '../shared/conversation';
import { errorFromResponse, errorFromStream, isAbortError, makeError } from './errors';
import { readSse } from './sse';
import type { ChatProvider, ChatRequest, StreamEvent } from './types';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface AnthropicEvent {
  type?: string;
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } };
  error?: { type?: string; message?: string };
}

export function buildAnthropicBody(request: ChatRequest) {
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    system: request.system,
    stream: true,
    messages: request.turns.map((turn) => ({ role: turn.role, content: turn.text })),
  };
}

export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;

  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': request.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(buildAnthropicBody(request)),
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      yield { type: 'error', error: makeError('network', (error as Error)?.message) };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', error: await errorFromResponse('anthropic', response) };
      return;
    }
    yield { type: 'status', phase: 'connected' };

    const usage: Usage = {};
    let stopReason: string | undefined;
    let stopped = false;
    try {
      for await (const sse of readSse(response.body, signal)) {
        let data: AnthropicEvent;
        try {
          data = JSON.parse(sse.data) as AnthropicEvent;
        } catch {
          continue;
        }
        switch (data.type ?? sse.event) {
          case 'message_start': {
            const u = data.message?.usage;
            if (u?.input_tokens !== undefined) {
              usage.inputTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            }
            break;
          }
          case 'content_block_start': {
            const type = data.content_block?.type;
            if (type === 'thinking' || type === 'redacted_thinking') yield { type: 'status', phase: 'thinking' };
            else if (type === 'text') yield { type: 'status', phase: 'writing' };
            break;
          }
          case 'content_block_delta':
            if (data.delta?.type === 'text_delta' && data.delta.text) yield { type: 'text', text: data.delta.text };
            break;
          case 'message_delta':
            if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
            if (data.usage?.output_tokens !== undefined) usage.outputTokens = data.usage.output_tokens;
            if (data.usage?.output_tokens_details?.thinking_tokens !== undefined) {
              usage.reasoningTokens = data.usage.output_tokens_details.thinking_tokens;
            }
            break;
          case 'message_stop':
            stopped = true;
            break;
          case 'error':
            yield { type: 'error', error: errorFromStream(data.error?.type, undefined, data.error?.message) };
            return;
          default:
            // ping 등 알 수 없는 이벤트는 무시한다(공식 권장).
            break;
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      yield { type: 'interrupted', reason: 'network', detail: (error as Error)?.message };
      return;
    }
    if (signal.aborted) return;
    if (!stopped) {
      yield { type: 'interrupted', reason: 'stream-ended' };
      return;
    }
    if (stopReason === 'refusal') {
      yield { type: 'error', error: makeError('refusal'), discardPartial: true };
      return;
    }
    yield { type: 'done', stopReason: stopReason ?? 'end_turn', usage };
  }
}
