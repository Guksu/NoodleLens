/**
 * 제공자별 HTTP·스트림 오류를 공통 형태로 바꾸고 사용자 안내 문구를 붙인다.
 * 오류 메시지에 키 일부가 섞여 올 수 있어 항상 가린다.
 */
import type { ErrorKind, MessageError, ProviderId } from '../shared/conversation';
import { clip, maskSecrets } from '../shared/text';

const GUIDE: Record<ErrorKind, string> = {
  auth: 'API 키가 올바르지 않거나 만료되었습니다. 설정에서 키를 확인해 주세요.',
  permission: '이 키로는 해당 모델이나 기능을 쓸 수 없습니다. 키 권한과 조직 설정을 확인해 주세요.',
  quota: '크레딧이 없거나 지출 한도에 도달했습니다. 제공자 콘솔에서 결제·한도를 확인해 주세요.',
  rate_limit: '요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.',
  invalid_request: '요청 형식이 거부되었습니다.',
  context_length: '보낸 내용이 모델의 입력 한도를 넘었습니다. 새 분석을 시작하거나 첨부 범위를 줄여 주세요.',
  not_found: '모델을 찾을 수 없습니다. 이 키로 쓸 수 있는 모델인지 확인해 주세요.',
  overloaded: '제공자 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.',
  server: '제공자 서버 오류입니다. 잠시 후 다시 시도해 주세요.',
  network: '네트워크 연결에 실패했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  refusal: '모델이 이 요청에 대한 응답을 거절했습니다. 질문을 바꿔 다시 시도해 주세요.',
  missing_key: '이 제공자의 API 키가 없습니다. 설정에서 키를 입력해 주세요.',
  consent_required: '데이터 전송 안내에 동의해야 모델에 질문할 수 있습니다.',
  unknown: '알 수 없는 오류가 발생했습니다.',
};

const RETRYABLE: ReadonlySet<ErrorKind> = new Set(['rate_limit', 'overloaded', 'server', 'network', 'unknown']);

export function guideFor(kind: ErrorKind): string {
  return GUIDE[kind];
}

export function makeError(
  kind: ErrorKind,
  detail?: string,
  extra: Partial<Pick<MessageError, 'status' | 'retryAfterSec' | 'requestId'>> = {},
): MessageError {
  const cleanDetail = detail ? clip(maskSecrets(detail), 300) : '';
  return {
    kind,
    message: cleanDetail ? `${GUIDE[kind]} (${cleanDetail})` : GUIDE[kind],
    retryable: RETRYABLE.has(kind),
    ...extra,
  };
}

function looksLikeContextLimit(message: string): boolean {
  return /context|too long|maximum.*tokens|token limit|prompt is too long/i.test(message);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

interface ErrorBody {
  type?: string;
  code?: string | null;
  message?: string;
  details?: { error_code?: string };
}

function readErrorBody(text: string): ErrorBody {
  try {
    const json = JSON.parse(text) as { error?: ErrorBody; detail?: unknown };
    if (json && typeof json.error === 'object' && json.error) return json.error;
    if (json && typeof json.detail === 'string') return { message: json.detail };
  } catch {
    // JSON이 아닌 오류 본문(프록시 등)
  }
  return { message: text.slice(0, 200) };
}

/** HTTP 오류 응답을 분류한다 */
export async function errorFromResponse(provider: ProviderId, response: Response): Promise<MessageError> {
  const text = await response.text().catch(() => '');
  const body = readErrorBody(text);
  const status = response.status;
  const message = body.message ?? '';
  const code = body.code ?? body.details?.error_code ?? '';
  const type = body.type ?? '';
  const extra = {
    status,
    retryAfterSec: parseRetryAfter(response.headers),
    requestId: response.headers.get('request-id') ?? response.headers.get('x-request-id') ?? undefined,
  };
  const detail = [status, type || code, message].filter(Boolean).join(' · ');

  if (status === 401) return makeError('auth', detail, extra);
  if (status === 402) return makeError('quota', detail, extra);
  if (status === 403) return makeError('permission', detail, extra);
  if (status === 404) return makeError('not_found', detail, extra);
  if (status === 413) return makeError('context_length', detail, extra);
  if (status === 429) {
    const quota =
      provider === 'openai'
        ? type === 'insufficient_quota' || /quota|credit|spend_limit|usage_limit|billing/i.test(String(code))
        : /spend_limit/i.test(String(code));
    return quota ? { ...makeError('quota', detail, extra), retryable: false } : makeError('rate_limit', detail, extra);
  }
  if (status === 529 || type === 'overloaded_error' || code === 'server_is_overloaded') return makeError('overloaded', detail, extra);
  if (status >= 500) return makeError('server', detail, extra);
  if (status === 400 || status === 422) {
    return makeError(looksLikeContextLimit(message) ? 'context_length' : 'invalid_request', detail, extra);
  }
  return makeError('unknown', detail, extra);
}

/** 스트림 중 오류 이벤트의 type/code를 분류한다 */
export function errorFromStream(type: string | undefined, code: string | undefined, message: string | undefined): MessageError {
  const key = `${type ?? ''} ${code ?? ''}`;
  const detail = [type || code, message].filter(Boolean).join(' · ');
  if (/overloaded|server_is_overloaded/.test(key)) return makeError('overloaded', detail);
  if (/rate_limit/.test(key)) return makeError('rate_limit', detail);
  if (/insufficient_quota|credit|spend_limit|usage_limit|billing/.test(key)) return { ...makeError('quota', detail), retryable: false };
  if (/authentication|invalid_api_key/.test(key)) return makeError('auth', detail);
  if (/permission/.test(key)) return makeError('permission', detail);
  if (/invalid_request/.test(key)) {
    return makeError(looksLikeContextLimit(message ?? '') ? 'context_length' : 'invalid_request', detail);
  }
  if (/api_error|server_error|timeout/.test(key)) return makeError('server', detail);
  return makeError('unknown', detail);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : (error as { name?: string })?.name === 'AbortError';
}
