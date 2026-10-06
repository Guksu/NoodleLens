/**
 * 평가용 페이지 도우미. esbuild로 묶어 데모 페이지에 주입한다.
 * - collect: 확장 프로그램 content script와 같은 수집기(collectSnapshot)로 스냅샷을 만든다.
 * - metric: 사례별 증상을 측정값으로 판정한다(LLM 판단을 쓰지 않음).
 * - applyCss: 모델이 낸 CSS를 적용하고 선택자가 실제 요소에 맞았는지 센다.
 */
import { collectSnapshot } from '../src/content/collect';
import { DEFAULT_LIMITS } from '../src/shared/snapshot';

function q(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no element: ${selector}`);
  return el;
}

function contentBox(el: Element) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const n = (v: string) => Number.parseFloat(v) || 0;
  return {
    left: r.left + n(cs.borderLeftWidth) + n(cs.paddingLeft),
    right: r.right - n(cs.borderRightWidth) - n(cs.paddingRight),
  };
}

function truncates(selector: string): boolean {
  const el = q(selector) as HTMLElement;
  const cs = getComputedStyle(el);
  const nowrap = cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre' || cs.getPropertyValue('text-wrap-mode') === 'nowrap';
  return (
    cs.display !== 'inline' &&
    cs.textOverflow === 'ellipsis' &&
    cs.overflowX !== 'visible' &&
    nowrap &&
    el.scrollWidth > el.clientWidth
  );
}

function noOverflow(selector: string): boolean {
  const el = q(selector);
  return el.scrollWidth <= el.clientWidth + 1;
}

function centeredX(selector: string): boolean {
  const el = q(selector);
  const parent = el.parentElement!;
  const box = contentBox(parent);
  const r = el.getBoundingClientRect();
  return Math.abs(r.left + r.width / 2 - (box.left + box.right) / 2) <= 1;
}

const METRICS: Record<string, (selector: string) => boolean> = {
  fitsViewport: (s) => q(s).getBoundingClientRect().right + window.scrollX <= document.documentElement.clientWidth + 1,
  truncates,
  sellerTruncates: () => truncates('.seller-name') && noOverflow('.seller'),
  centeredX,
  fitsParent: (s) => {
    const el = q(s);
    const box = contentBox(el.parentElement!);
    return el.getBoundingClientRect().width <= box.right - box.left + 1;
  },
  articleFits: () => noOverflow('.article-layout'),
  fileTruncates: () => truncates('.file-name') && noOverflow('.file-row'),
  ribbonInside: () => {
    const card = q('.ribbon-card');
    const after = getComputedStyle(card, '::after');
    if (after.content === 'none' || after.content === 'normal' || after.display === 'none') return true;
    if (getComputedStyle(card).overflowX !== 'visible') return true;
    if (after.position !== 'absolute' && after.position !== 'fixed') return true;
    const right = Number.parseFloat(after.right);
    return Number.isNaN(right) || right >= -1;
  },
  clamped: (s) => {
    const el = q(s);
    const cs = getComputedStyle(el);
    return cs.getPropertyValue('-webkit-line-clamp') === '2' && el.scrollHeight > el.clientHeight;
  },
  imageHasRatio: (s) => {
    const img = q(s) as HTMLImageElement;
    return getComputedStyle(img).aspectRatio !== 'auto' || (img.hasAttribute('width') && img.hasAttribute('height'));
  },
};

function collect(selector: string) {
  return collectSnapshot(q(selector), {
    snapshotId: 'eval-snapshot',
    idOffset: 0,
    limits: DEFAULT_LIMITS,
    isOwnNode: () => false,
  }).snapshot;
}

function metric(name: string, selector: string): boolean {
  const fn = METRICS[name];
  if (!fn) throw new Error(`unknown metric ${name}`);
  return fn(selector);
}

function applyCss(css: string) {
  const sheet = new CSSStyleSheet();
  let parseError: string | null = null;
  try {
    sheet.replaceSync(css);
  } catch (error) {
    parseError = String(error);
  }
  const matched: Array<{ selector: string; count: number }> = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        let count = 0;
        try {
          count = document.querySelectorAll(rule.selectorText.replace(/::?(before|after)\b/g, '')).length;
        } catch {
          count = 0;
        }
        matched.push({ selector: rule.selectorText, count });
      } else if ('cssRules' in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  visit(sheet.cssRules);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return { parseError, matched };
}

(window as unknown as { __nl: unknown }).__nl = { collect, metric, applyCss };
