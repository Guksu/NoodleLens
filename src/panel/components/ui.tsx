import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { ProviderId } from '../../shared/conversation';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {icon}
      {children !== undefined && <span className="btn-label">{children}</span>}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const AVATAR_LETTER: Record<ProviderId, string> = { anthropic: 'C', openai: 'G', mock: 'M' };

/** 제공자 구분용 글자 아바타. 로고를 쓰지 않는다. */
export function ProviderAvatar({ provider, warn = false }: { provider: ProviderId; warn?: boolean }) {
  return (
    <span className={`provider-avatar provider-${provider}`} aria-hidden="true">
      {AVATAR_LETTER[provider]}
      {warn && <span className="key-dot" />}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch-row ${disabled ? 'is-disabled' : ''}`}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {description && <span className="switch-desc">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect width="32" height="32" rx="9" fill="var(--logo-bg)" />
      <circle cx="14" cy="14" r="7.2" fill="none" stroke="var(--brand)" strokeWidth="2.6" />
      <path d="M19.5 19.5 25.5 25.5" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M9.4 14.5c1.15-1.8 2.3-1.8 3.05 0s1.9 1.8 3.05 0 1.9-1.8 3.05 0"
        fill="none"
        stroke="var(--brand-light)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
