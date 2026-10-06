/**
 * 제공자·모델 목록. 모델 id와 가격은 2026-10-06 공식 문서(models/pricing) 기준이다.
 * 목록은 짧게 유지한다(균형·고성능·저비용 각 1개).
 */
import type { ProviderId } from '../shared/conversation';
import { AnthropicProvider } from './anthropic';
import { MockProvider } from './mock';
import { OpenAiProvider } from './openai';
import type { ChatProvider, ModelInfo, ProviderInfo } from './types';

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    shortLabel: 'Claude',
    keyPlaceholder: 'sk-ant-…',
    keyHelpUrl: 'https://platform.claude.com/settings/keys',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: '균형 · 입력 $2 / 출력 $10 (1M 토큰)', vision: true, isDefault: true },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: '고성능 · $4 / $20', vision: true },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: '빠름·저비용 · $1 / $5', vision: true },
    ],
  },
  openai: {
    id: 'openai',
    label: 'GPT (OpenAI)',
    shortLabel: 'GPT',
    keyPlaceholder: 'sk-…',
    keyHelpUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: '균형 · 입력 $2 / 출력 $10 (1M 토큰)', vision: true, isDefault: true },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: '고성능 · $10 / $50', vision: true },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: '저비용 · $0.10 / $0.50', vision: true },
    ],
  },
  mock: {
    id: 'mock',
    label: '모의 응답 (개발용)',
    shortLabel: 'Mock',
    keyPlaceholder: '',
    keyHelpUrl: '',
    devOnly: true,
    models: [{ id: 'mock-echo', label: '모의 응답', note: '네트워크 없이 규칙 검사 결과를 옮겨 적음', vision: false, isDefault: true }],
  },
};

export const REAL_PROVIDERS: ProviderId[] = ['anthropic', 'openai'];

export function defaultModel(provider: ProviderId): string {
  const models = PROVIDERS[provider].models;
  return (models.find((m) => m.isDefault) ?? models[0])!.id;
}

export function findModel(provider: ProviderId, modelId: string): ModelInfo | undefined {
  return PROVIDERS[provider].models.find((m) => m.id === modelId);
}

export function modelLabel(provider: ProviderId, modelId: string): string {
  return findModel(provider, modelId)?.label ?? modelId;
}

const instances = new Map<ProviderId, ChatProvider>();

export function getProvider(id: ProviderId): ChatProvider {
  let provider = instances.get(id);
  if (!provider) {
    provider = id === 'anthropic' ? new AnthropicProvider() : id === 'openai' ? new OpenAiProvider() : new MockProvider();
    instances.set(id, provider);
  }
  return provider;
}

/** 테스트에서 제공자를 바꿔 끼운다 */
export function setProviderForTest(id: ProviderId, provider: ChatProvider) {
  instances.set(id, provider);
}
