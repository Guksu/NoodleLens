/**
 * 비밀이 아닌 설정(chrome.storage.local). 테스트 환경에서는 메모리에 둔다.
 */
import type { ProviderId } from '../shared/conversation';
import { defaultModel } from '../providers/registry';

export interface Settings {
  /** 새 분석에서 쓸 제공자 */
  defaultProvider: ProviderId;
  /** 제공자별로 마지막에 고른 모델 */
  models: Record<ProviderId, string>;
  /** 개발용 모의 응답 제공자 표시 */
  showMock: boolean;
  /** 데이터 전송 안내에 동의한 시각 */
  consentAt: number | null;
  maxOutputTokens: number;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: 'anthropic',
  models: {
    anthropic: defaultModel('anthropic'),
    openai: defaultModel('openai'),
    mock: defaultModel('mock'),
  },
  showMock: false,
  consentAt: null,
  maxOutputTokens: 8000,
};

const KEY = 'nl.settings';
let memory: Settings | null = null;

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

export async function loadSettings(): Promise<Settings> {
  let stored: Partial<Settings> | undefined;
  if (hasChromeStorage()) stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  else stored = memory ?? undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    models: { ...DEFAULT_SETTINGS.models, ...stored?.models },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (hasChromeStorage()) await chrome.storage.local.set({ [KEY]: settings });
  else memory = settings;
}

export function resetSettingsForTest() {
  memory = null;
}
