import { ExternalLink, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PROVIDERS } from '../../providers/registry';
import { countStored } from '../../storage/db';
import type { KeyPersistence } from '../../storage/secrets';
import { deleteAllConversations, hasAllSites, removeKey, requestAllSites, revokeAllSites, setShowMock, storeKey } from '../actions';
import { pushNotice, useStore } from '../store';
import { ProviderAvatar, Switch } from './ui';

function KeyCard({ provider }: { provider: 'openai' | 'anthropic' }) {
  const info = PROVIDERS[provider];
  const status = useStore((s) => s.keyStatus[provider]);
  const [value, setValue] = useState('');
  const [persistence, setPersistence] = useState<KeyPersistence>('device');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!value.trim()) return;
    setSaving(true);
    try {
      await storeKey(provider, value, persistence);
      setValue('');
      pushNotice({ tone: 'success', text: `${info.shortLabel} 키를 저장했습니다.` }, 3000);
    } catch (error) {
      pushNotice({ tone: 'error', text: `키를 저장하지 못했습니다: ${String((error as Error)?.message ?? error)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="key-card">
      <div className="card-head">
        <ProviderAvatar provider={provider} />
        <h3>{info.label}</h3>
        {status.present ? (
          <span className="badge badge-ok">
            저장됨 ····{status.hint} · {status.persistence === 'session' ? '브라우저 닫을 때까지' : '이 기기'}
          </span>
        ) : (
          <span className="badge">키 없음</span>
        )}
      </div>
      <form
        className="key-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={status.present ? '새 키로 바꾸기' : info.keyPlaceholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label={`${info.shortLabel} API 키`}
        />
        <fieldset className="radio-row">
          <legend className="sr-only">보관 방식</legend>
          <label>
            <input type="radio" name={`persist-${provider}`} checked={persistence === 'device'} onChange={() => setPersistence('device')} />
            이 기기에 저장(암호화)
          </label>
          <label>
            <input type="radio" name={`persist-${provider}`} checked={persistence === 'session'} onChange={() => setPersistence('session')} />
            브라우저를 닫을 때까지만
          </label>
        </fieldset>
        <div className="key-actions">
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!value.trim() || saving}>
            <KeyRound size={14} aria-hidden="true" />
            <span className="btn-label">저장</span>
          </button>
          {status.present && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeKey(provider)}>
              <Trash2 size={14} aria-hidden="true" />
              <span className="btn-label">키 삭제</span>
            </button>
          )}
          <a className="link-btn" href={info.keyHelpUrl} target="_blank" rel="noopener noreferrer">
            키 발급 <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      </form>
    </div>
  );
}

export function SettingsView() {
  const showMock = useStore((s) => s.settings.showMock);
  const [allSites, setAllSites] = useState<boolean | null>(null);
  const [counts, setCounts] = useState<{ conversations: number; messages: number; snapshots: number } | null>(null);
  const conversationsLength = useStore((s) => s.conversations.length);

  useEffect(() => {
    void hasAllSites().then(setAllSites);
    const onChange = () => void hasAllSites().then(setAllSites);
    chrome.permissions.onAdded.addListener(onChange);
    chrome.permissions.onRemoved.addListener(onChange);
    return () => {
      chrome.permissions.onAdded.removeListener(onChange);
      chrome.permissions.onRemoved.removeListener(onChange);
    };
  }, []);

  useEffect(() => {
    void countStored().then(setCounts);
  }, [conversationsLength]);

  return (
    <section className="view settings" aria-label="설정">
      <div className="view-head">
        <h2>설정</h2>
      </div>

      <h3 className="section-title">API 키</h3>
      <p className="section-desc">
        본인 키로 OpenAI·Anthropic API를 직접 호출합니다. API 사용료는 각 제공자 콘솔에서 따로 청구되며, ChatGPT·Claude 구독에는 포함되지 않습니다.
        키는 이 브라우저에만 두고 제공자 API 요청 외에는 어디에도 보내지 않습니다. 전용 키를 만들고 지출 한도를 걸어 두기를 권장합니다.
      </p>
      <KeyCard provider="anthropic" />
      <KeyCard provider="openai" />

      <h3 className="section-title">사이트 접근</h3>
      <div className="settings-block">
        <p className="section-desc">
          기본적으로 툴바의 NoodleLens 아이콘을 누른 탭에서만 요소를 선택할 수 있습니다(activeTab). 탭마다 아이콘을 누르기 번거롭다면 모든 사이트 접근을 허용할 수 있습니다.
        </p>
        <Switch
          label="모든 사이트에서 바로 선택"
          description={allSites ? '허용됨 · 끄면 권한을 반납합니다' : '켜면 Chrome이 권한을 확인합니다'}
          checked={Boolean(allSites)}
          disabled={allSites === null}
          onChange={(value) => (value ? requestAllSites() : void revokeAllSites())}
        />
      </div>

      <h3 className="section-title">데이터</h3>
      <div className="settings-block">
        <p className="section-desc">
          대화와 수집 자료(스냅샷)는 이 브라우저의 확장 프로그램 저장소에만 있습니다.
          {counts && ` 지금 대화 ${counts.conversations}개, 메시지 ${counts.messages}개, 스냅샷 ${counts.snapshots}개.`}
        </p>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={!counts || counts.conversations === 0}
          onClick={() => {
            if (window.confirm('모든 대화와 수집 자료를 삭제합니다. 되돌릴 수 없습니다.')) void deleteAllConversations();
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          <span className="btn-label">모든 대화·수집 자료 삭제</span>
        </button>
      </div>

      <h3 className="section-title">개발자</h3>
      <div className="settings-block">
        <Switch
          label="모의 응답 제공자 표시"
          description="네트워크 없이 화면을 확인하는 개발용 제공자입니다. 실제 모델 응답이 아닙니다."
          checked={showMock || __NL_DEV__}
          disabled={__NL_DEV__}
          onChange={(value) => void setShowMock(value)}
        />
      </div>

      <h3 className="section-title">개인정보</h3>
      <div className="settings-block privacy-card">
        <ShieldCheck size={16} aria-hidden="true" />
        <ul>
          <li>입력창 값, 비밀번호, 쿠키, 편집 중인 글은 수집하지 않습니다.</li>
          <li>페이지 주소는 쿼리 값과 해시를 지우고 보냅니다.</li>
          <li>질문을 보낼 때만 선택한 제공자에게 자료가 전송됩니다. NoodleLens 개발자 서버는 없습니다.</li>
          <li>수집 자료는 정해진 목적(선택한 요소의 레이아웃 설명)에만 쓰고 광고·판매에 쓰지 않습니다.</li>
        </ul>
      </div>
    </section>
  );
}
