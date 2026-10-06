/**
 * 대화·메시지 데이터 모델. 스냅샷(첨부 자료)은 별도 저장소에 두고 id로만 연결한다.
 */

export type ProviderId = 'openai' | 'anthropic' | 'mock';

export interface Conversation {
  id: string;
  title: string;
  /** 대화마다 제공자를 고정한다. 다른 제공자로 기존 대화를 자동 전송하지 않는다 */
  provider: ProviderId;
  /** 같은 제공자 안에서는 모델을 바꿀 수 있다. 각 답변에 실제 사용한 모델이 남는다 */
  model: string;
  createdAt: number;
  updatedAt: number;
  pageUrl?: string;
  pageTitle?: string;
  targetLabel?: string;
  lastSnapshotId?: string;
  /** 이 대화에서 쓴 가장 큰 요소 번호(E번호). 새 스냅샷은 이 다음 번호부터 쓴다 */
  maxElementNumber: number;
}

export type ErrorKind =
  | 'auth'
  | 'permission'
  | 'quota'
  | 'rate_limit'
  | 'invalid_request'
  | 'context_length'
  | 'not_found'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'refusal'
  | 'missing_key'
  | 'consent_required'
  | 'unknown';

export interface MessageError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterSec?: number;
  requestId?: string;
}

export interface UserMessage {
  id: string;
  conversationId: string;
  role: 'user';
  text: string;
  createdAt: number;
  /** 이 질문과 함께 보낸 스냅샷 */
  snapshotId?: string;
}

/**
 * pending: 요청 준비·연결 중
 * streaming: 응답을 받는 중
 * complete: 정상 종료
 * cancelled: 사용자가 중단(받은 부분 보존)
 * interrupted: 연결 끊김·패널 닫힘 등으로 도중에 끊김(받은 부분 보존)
 * error: 제공자 오류·거절 등
 */
export type AssistantStatus = 'pending' | 'streaming' | 'complete' | 'cancelled' | 'interrupted' | 'error';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface AssistantMessage {
  id: string;
  conversationId: string;
  role: 'assistant';
  replyTo: string;
  provider: ProviderId;
  model: string;
  text: string;
  status: AssistantStatus;
  createdAt: number;
  updatedAt: number;
  error?: MessageError;
  /** interrupted일 때 원인 */
  interruptReason?: 'network' | 'panel-closed' | 'stream-ended';
  stopReason?: string;
  usage?: Usage;
  startedAt?: number;
  firstTokenAt?: number;
  finishedAt?: number;
  /** 모의 응답 여부. 실제 모델 응답과 구분해 표시한다 */
  mock?: boolean;
}

export type Message = UserMessage | AssistantMessage;

export function isTerminal(status: AssistantStatus): boolean {
  return status === 'complete' || status === 'cancelled' || status === 'interrupted' || status === 'error';
}

export function isActive(status: AssistantStatus): boolean {
  return status === 'pending' || status === 'streaming';
}

export function sortMessages<T extends Message>(messages: T[]): T[] {
  return [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
