import type { MessageError, ProviderId, Usage } from '../shared/conversation';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  turns: ChatTurn[];
  maxOutputTokens: number;
  apiKey: string;
}

export type StreamEvent =
  | { type: 'status'; phase: 'connected' | 'thinking' | 'writing' }
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: string; usage?: Usage }
  /** 응답 시작 전 실패나 제공자가 보낸 오류. discardPartial이면 받은 부분을 버린다(거절 등) */
  | { type: 'error'; error: MessageError; discardPartial?: boolean }
  /** 응답을 받다가 연결이 끊김. 받은 부분은 보존한다 */
  | { type: 'interrupted'; reason: 'network' | 'stream-ended'; detail?: string };

export interface ModelInfo {
  id: string;
  label: string;
  /** 짧은 설명(가격·특징). 2026-10 공식 문서 기준 */
  note: string;
  vision: boolean;
  isDefault?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  shortLabel: string;
  keyPlaceholder: string;
  keyHelpUrl: string;
  models: ModelInfo[];
  devOnly?: boolean;
}

export interface ChatProvider {
  readonly id: ProviderId;
  /**
   * 응답을 스트림으로 받는다. signal이 abort되면 조용히 끝나야 한다(호출 측이 cancelled 처리).
   * HTTP 오류·스트림 오류는 error 이벤트로 알리고 throw하지 않는다.
   */
  stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent>;
}
