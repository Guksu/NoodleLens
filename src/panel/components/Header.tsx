import { Check, ChevronDown, History, KeyRound, Settings, SquarePen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ProviderId } from '../../shared/conversation';
import { PROVIDERS, REAL_PROVIDERS, modelLabel } from '../../providers/registry';
import { chooseModel, newAnalysis, providerReady, setView } from '../actions';
import { shallowEqual, store, useStore } from '../store';
import { IconButton, Logo, ProviderAvatar } from './ui';

function useCurrentModel() {
  return useStore((s) => {
    const conversation = s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined;
    return conversation
      ? { provider: conversation.provider, model: conversation.model, locked: true }
      : { provider: s.newChat.provider, model: s.newChat.model, locked: false };
  }, shallowEqual);
}

/**
 * 모델 메뉴. 항목은 tabIndex -1이고 방향키·Home·End로 옮긴다(로빙 포커스).
 * Esc나 항목 선택으로 닫으면 포커스가 모델 버튼으로 돌아가고, 바깥을 눌러 닫으면 포커스를 뺏지 않는다.
 */
function ModelMenu({ onClose }: { onClose: (restoreFocus: boolean) => void }) {
  const current = useCurrentModel();
  const showMock = useStore((s) => s.settings.showMock || __NL_DEV__);
  const keyStatus = useStore((s) => s.keyStatus);
  const hasMessages = useStore((s) => Boolean(s.activeId && (s.messages[s.activeId]?.length ?? 0) > 0));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const picker = ref.current?.parentElement;
      if (picker && !picker.contains(event.target as Node)) onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index < 0 ? -1 : index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(-1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      onClose(true);
    } else if (event.key === 'Tab') onClose(false);
  };

  const providers: ProviderId[] = showMock ? [...REAL_PROVIDERS, 'mock'] : REAL_PROVIDERS;

  const pick = async (provider: ProviderId, model: string) => {
    if (current.locked && hasMessages && provider !== current.provider) {
      const ok = window.confirm(
        `${PROVIDERS[provider].shortLabel}로 바꾸면 새 분석이 시작됩니다. 지금 대화 내용은 ${PROVIDERS[provider].shortLabel}에 보내지 않습니다. 계속할까요?`,
      );
      if (!ok) return;
    }
    onClose(true);
    await chooseModel(provider, model);
  };

  return (
    <div className="menu model-menu" role="menu" aria-label="모델 선택" ref={ref} onKeyDown={onKeyDown}>
      {providers.map((provider) => {
        const info = PROVIDERS[provider];
        const ready = provider === 'mock' || keyStatus[provider as 'openai' | 'anthropic'].present;
        const otherProvider = current.locked && hasMessages && provider !== current.provider;
        return (
          <div key={provider} className="menu-group" role="group" aria-label={info.label}>
            <div className="menu-group-title">
              <span>{info.label}</span>
              {otherProvider && <span className="menu-hint">새 분석으로 시작</span>}
              {!ready && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="menu-key-link"
                  onClick={() => {
                    onClose(false);
                    setView('settings');
                  }}
                >
                  <KeyRound size={11} aria-hidden="true" /> 키 입력
                </button>
              )}
            </div>
            {info.models.map((model) => {
              const selected = provider === current.provider && model.id === current.model;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  tabIndex={-1}
                  className={`menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => void pick(provider, model.id)}
                >
                  <ProviderAvatar provider={provider} />
                  <span className="menu-item-main">
                    <span className="menu-item-label">{model.label}</span>
                    <span className="menu-item-note">{model.note}</span>
                  </span>
                  {selected && <Check size={14} className="menu-check" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        );
      })}
      <p className="menu-footnote">가격은 1M 토큰당 달러(2026-10 공식 문서). 대화마다 제공자가 고정됩니다.</p>
    </div>
  );
}

export function Header() {
  const current = useCurrentModel();
  const view = useStore((s) => s.view);
  const ready = useStore((s) => providerReady(s, current.provider));
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  return (
    <header className="header">
      <div className="header-left">
        <Logo />
        <div className="model-picker">
          <button
            ref={triggerRef}
            type="button"
            className="model-button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            onKeyDown={(event) => {
              if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                setOpen(true);
              }
            }}
            title={ready ? '모델 선택' : '모델 선택 · API 키가 필요합니다'}
          >
            <ProviderAvatar provider={current.provider} />
            <span className="model-button-label">{modelLabel(current.provider, current.model)}</span>
            <ChevronDown size={14} className="model-button-chevron" aria-hidden="true" />
          </button>
          {open && <ModelMenu onClose={close} />}
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
          <SquarePen size={16} />
        </IconButton>
        <IconButton label="기록" className={view === 'history' ? 'is-active' : ''} onClick={() => setView(view === 'history' ? 'chat' : 'history')}>
          <History size={16} />
        </IconButton>
        <IconButton label="설정" className={view === 'settings' ? 'is-active' : ''} onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}>
          <Settings size={16} />
        </IconButton>
      </nav>
    </header>
  );
}
