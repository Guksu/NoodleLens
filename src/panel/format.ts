import type { AssistantMessage } from '../shared/conversation';
import { formatNumber } from '../shared/text';

export function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  if (diff < minute) return '방금';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}분 전`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}시간 전`;
  const date = new Date(timestamp);
  const today = new Date(now);
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString('ko-KR', sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function originOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? 'file://' : parsed.host;
  } catch {
    return url;
  }
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}초`;
}

export const STATUS_LABEL: Record<AssistantMessage['status'], string> = {
  pending: '연결 중',
  streaming: '생성 중',
  complete: '완료',
  cancelled: '중단됨',
  interrupted: '연결 끊김',
  error: '오류',
};

export function interruptText(message: AssistantMessage): string {
  if (message.interruptReason === 'panel-closed') return '패널이 닫혀 응답 생성이 끊겼습니다. 받은 부분까지 저장했습니다.';
  if (message.interruptReason === 'stream-ended') return '응답이 끝나기 전에 연결이 닫혔습니다. 받은 부분까지 저장했습니다.';
  return '네트워크 연결이 끊겨 응답이 중간에 멈췄습니다. 받은 부분까지 저장했습니다.';
}

export function usageText(message: AssistantMessage): string | null {
  const parts: string[] = [];
  if (message.usage?.inputTokens !== undefined) parts.push(`입력 ${formatNumber(message.usage.inputTokens)}`);
  if (message.usage?.outputTokens !== undefined) {
    const reasoning = message.usage.reasoningTokens ? ` (추론 ${formatNumber(message.usage.reasoningTokens)})` : '';
    parts.push(`출력 ${formatNumber(message.usage.outputTokens)}${reasoning}`);
  }
  if (parts.length === 0) return null;
  return `${parts.join(' · ')} 토큰`;
}

export function timingText(message: AssistantMessage): string | null {
  if (!message.startedAt || !message.finishedAt) return null;
  const total = seconds(message.finishedAt - message.startedAt);
  const first = message.firstTokenAt ? ` · 첫 글자 ${seconds(message.firstTokenAt - message.startedAt)}` : '';
  return `${total}${first}`;
}
