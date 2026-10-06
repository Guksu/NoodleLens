/**
 * OpenAI Responses API 어댑터 (POST /v1/responses, stream: true).
 *
 * store:false로 보내 OpenAI 쪽에 응답 상태를 저장하지 않게 하고, 대화 이력은 매번 input으로 보낸다.
 * max_output_tokens에는 reasoning 토큰도 포함된다.
 */
import type { Usage } from '../shared/conversation';
import { errorFromResponse, errorFromStream, isAbortError, makeError } from './errors';
import { readSse } from './sse';
import type { ChatProvider, ChatRequest, StreamEvent } from './types';

export const OPENAI_URL = 'https://api.openai.com/v1/responses';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAiEvent {
  type?: string;
  delta?: string;
  code?: string;
  message?: string;
  item?: { type?: string };
  response?: {
    usage?: OpenAiUsage;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
}

export function buildOpenAiBody(request: ChatRequest) {
  return {
    model: request.model,
    instructions: request.system,
    input: request.turns.map((turn) => ({ role: turn.role, content: turn.text })),
    stream: true,
    store: false,
    max_output_tokens: request.maxOutputTokens,
  };
}

function toUsage(usage: OpenAiUsage | undefined): Usage {
  const out: Usage = {};
  if (usage?.input_tokens !== undefined) out.inputTokens = usage.input_tokens;
  if (usage?.output_tokens !== undefined) out.outputTokens = usage.output_tokens;
  if (usage?.output_tokens_details?.reasoning_tokens !== undefined) {
    out.reasoningTokens = usage.output_tokens_details.reasoning_tokens;
  }
  return out;
}

export class OpenAiProvider implements ChatProvider {
  readonly id = 'openai' as const;

  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(buildOpenAiBody(request)),
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      yield { type: 'error', error: makeError('network', (error as Error)?.message) };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', error: await errorFromResponse('openai', response) };
      return;
    }
    yield { type: 'status', phase: 'connected' };

    let refusal = '';
    let wroteText = false;
    try {
      for await (const sse of readSse(response.body, signal)) {
        let data: OpenAiEvent;
        try {
          data = JSON.parse(sse.data) as OpenAiEvent;
        } catch {
          continue;
        }
        switch (data.type ?? sse.event) {
          case 'response.output_item.added':
            if (data.item?.type === 'reasoning') yield { type: 'status', phase: 'thinking' };
            else if (data.item?.type === 'message') yield { type: 'status', phase: 'writing' };
            break;
          case 'response.output_text.delta':
            if (data.delta) {
              wroteText = true;
              yield { type: 'text', text: data.delta };
            }
            break;
          case 'response.refusal.delta':
            refusal += data.delta ?? '';
            break;
          case 'response.completed': {
            const usage = toUsage(data.response?.usage);
            if (!wroteText && refusal) {
              yield { type: 'error', error: makeError('refusal', refusal), discardPartial: true };
              return;
            }
            yield { type: 'done', stopReason: 'completed', usage };
            return;
          }
          case 'response.incomplete': {
            const reason = data.response?.incomplete_details?.reason ?? 'unknown';
            const usage = toUsage(data.response?.usage);
            if (reason === 'max_output_tokens') {
              yield { type: 'done', stopReason: 'max_tokens', usage };
            } else {
              yield { type: 'error', error: makeError('refusal', `incomplete: ${reason}`), discardPartial: reason === 'content_filter' };
            }
            return;
          }
          case 'response.failed': {
            const error = data.response?.error;
            yield { type: 'error', error: errorFromStream(undefined, error?.code, error?.message) };
            return;
          }
          case 'error':
            yield { type: 'error', error: errorFromStream(undefined, data.code, data.message) };
            return;
          default:
            break;
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      yield { type: 'interrupted', reason: 'network', detail: (error as Error)?.message };
      return;
    }
    if (signal.aborted) return;
    // response.completed 없이 스트림이 끝났다.
    yield { type: 'interrupted', reason: 'stream-ended' };
  }
}
