import type { BoxVariant, Overlay } from './overlay';

export function describeElement(el: Element): { main: string; dim: string } {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id.slice(0, 40)}` : '';
  const classes = Array.from(el.classList)
    .slice(0, 2)
    .map((name) => `.${name.slice(0, 28)}`)
    .join('');
  const r = el.getBoundingClientRect();
  const display = getComputedStyle(el).display;
  return {
    main: `${tag}${id}${classes}${el.classList.length > 2 ? '…' : ''}`,
    dim: `${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10} · ${display}`,
  };
}

/**
 * 요소의 위치를 매 프레임 따라가며 강조 상자를 그린다.
 * 스크롤·리사이즈·애니메이션으로 위치가 바뀌어도 상자가 맞게 움직인다.
 * 따라갈 대상이 없으면 requestAnimationFrame을 멈춘다.
 */
export class Tracker {
  private frame = 0;
  private target: Element | null = null;
  private variant: BoxVariant = 'hover';
  private until = Number.POSITIVE_INFINITY;
  private withLabel = true;

  constructor(private readonly overlay: Overlay) {}

  follow(el: Element, variant: BoxVariant, durationMs = Number.POSITIVE_INFINITY, withLabel = true) {
    this.target = el;
    this.variant = variant;
    this.withLabel = withLabel;
    this.until = performance.now() + durationMs;
    this.overlay.attach();
    this.draw();
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  get current(): Element | null {
    return this.target;
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.target = null;
    this.overlay.hideBox();
    this.overlay.detachIfIdle();
  }

  private tick = () => {
    this.frame = 0;
    if (!this.target) return;
    if (performance.now() > this.until || !this.target.isConnected) {
      this.stop();
      return;
    }
    this.draw();
    this.frame = requestAnimationFrame(this.tick);
  };

  private draw() {
    if (!this.target) return;
    const r = this.target.getBoundingClientRect();
    this.overlay.showBox(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      this.variant,
      this.withLabel ? describeElement(this.target) : null,
    );
  }
}
