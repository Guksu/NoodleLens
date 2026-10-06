import { Check, ChevronDown, History, KeyRound, Plus, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProviderId } from '../../shared/conversation';
import { PROVIDERS, REAL_PROVIDERS, modelLabel } from '../../providers/registry';
import { chooseModel, newAnalysis, providerReady, setView } from '../actions';
import { shallowEqual, store, useStore } from '../store';
import { IconButton, Logo } from './ui';

function useCurrentModel() {
  return useStore((s) => {
    const conversation = s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined;
    return conversation
      ? { provider: conversation.provider, model: conversation.model, locked: true }
      : { provider: s.newChat.provider, model: s.newChat.model, locked: false };
  }, shallowEqual);
}

function ModelMenu({ onClose }: { onClose: () => void }) {
  const current = useCurrentModel();
  const showMock = useStore((s) => s.settings.showMock || __NL_DEV__);
  const keyStatus = useStore((s) => s.keyStatus);
  const hasMessages = useStore((s) => Boolean(s.activeId && (s.messages[s.activeId]?.length ?? 0) > 0));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const providers: ProviderId[] = showMock ? [...REAL_PROVIDERS, 'mock'] : REAL_PROVIDERS;

  const pick = async (provider: ProviderId, model: string) => {
    if (current.locked && hasMessages && provider !== current.provider) {
      const ok = window.confirm(
        `${PROVIDERS[provider].shortLabel}로 바꾸면 새 분석이 시작됩니다. 지금 대화 내용은 ${PROVIDERS[provider].shortLabel}에 보내지 않습니다. 계속할까요?`,
      );
      if (!ok) return;
    }
    onClose();
    await chooseModel(provider, model);
  };

  return (
    <div className="menu model-menu" role="menu" ref={ref}>
      {providers.map((provider) => {
        const info = PROVIDERS[provider];
        const ready = provider === 'mock' || keyStatus[provider as 'openai' | 'anthropic'].present;
        const otherProvider = current.locked && hasMessages && provider !== current.provider;
        return (
          <div key={provider} className="menu-group">
            <div className="menu-group-title">
              <span>{info.label}</span>
              {!ready && (
                <button
                  type="button"
                  className="menu-key-link"
                  onClick={() => {
                    onClose();
                    setView('settings');
                  }}
                >
                  <KeyRound size={12} /> 키 필요
                </button>
              )}
              {otherProvider && <span className="menu-hint">새 분석으로 시작</span>}
            </div>
            {info.models.map((model) => {
              const selected = provider === current.provider && model.id === current.model;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => void pick(provider, model.id)}
                >
                  <span className="menu-item-main">
                    <span className="menu-item-label">{model.label}</span>
                    <span className="menu-item-note">{model.note}</span>
                  </span>
                  {selected && <Check size={14} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        );
      })}
      <p className="menu-footnote">가격은 2026-10 공식 문서 기준(1M 토큰당 달러)입니다. 대화마다 제공자가 고정됩니다.</p>
    </div>
  );
}

export function Header() {
  const current = useCurrentModel();
  const view = useStore((s) => s.view);
  const ready = useStore((s) => providerReady(s, current.provider));
  const [open, setOpen] = useState(false);

  return (
    <header className="header">
      <div className="header-left">
        <Logo />
        <div className="model-picker">
          <button
            type="button"
            className="model-button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            title="모델 선택"
          >
            <span className={`provider-dot provider-${current.provider}`} aria-hidden="true" />
            <span className="model-button-label">{modelLabel(current.provider, current.model)}</span>
            {!ready && <KeyRound size={13} className="model-button-warn" aria-label="API 키 필요" />}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {open && <ModelMenu onClose={() => setOpen(false)} />}
        </div>
      </div>
      <nav className="header-actions" aria-label="패널 메뉴">
        <IconButton
          label="새 분석"
          onClick={() => {
            newAnalysis();
            store.set((s) => ({ ...s, view: 'chat' }));
          }}
        >
          <Plus size={17} />
        </IconButton>
        <IconButton label="기록" className={view === 'history' ? 'is-active' : ''} onClick={() => setView(view === 'history' ? 'chat' : 'history')}>
          <History size={17} />
        </IconButton>
        <IconButton label="설정" className={view === 'settings' ? 'is-active' : ''} onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}>
          <Settings size={17} />
        </IconButton>
      </nav>
    </header>
  );
}
