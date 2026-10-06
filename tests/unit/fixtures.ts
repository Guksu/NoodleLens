import {
  DEFAULT_LIMITS,
  NO_EXCLUSIONS,
  SNAPSHOT_SCHEMA_VERSION,
  type ElementSnapshot,
  type Snapshot,
  type StoredSnapshot,
} from '../../src/shared/snapshot';

type ElementInput = Partial<Omit<ElementSnapshot, 'rect' | 'box'>> & {
  id: string;
  role: ElementSnapshot['role'];
  rect?: Partial<ElementSnapshot['rect']>;
  box?: Partial<ElementSnapshot['box']>;
};

export function el(input: ElementInput): ElementSnapshot {
  const x = input.rect?.x ?? input.rect?.left ?? 0;
  const y = input.rect?.y ?? input.rect?.top ?? 0;
  const width = input.rect?.width ?? 100;
  const height = input.rect?.height ?? 20;
  return {
    detail: input.role === 'target' || input.depth === 1 ? 'full' : 'compact',
    tag: 'div',
    label: input.label ?? `div.${input.id.toLowerCase()}`,
    attributes: {},
    omittedAttributeCount: 0,
    classOmittedCount: 0,
    text: { kind: 'none' },
    childElementCount: 0,
    flags: {},
    styles: {},
    ...input,
    rect: { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, ...input.rect },
    box: {
      clientWidth: Math.round(width),
      clientHeight: Math.round(height),
      scrollWidth: Math.round(width),
      scrollHeight: Math.round(height),
      offsetWidth: Math.round(width),
      offsetHeight: Math.round(height),
      scrollLeft: 0,
      scrollTop: 0,
      clientLeft: 0,
      clientTop: 0,
      ...input.box,
    },
  } as ElementSnapshot;
}

export function snapshot(elements: ElementSnapshot[], overrides: Partial<Snapshot> = {}): Snapshot {
  const target = elements.find((e) => e.role === 'target');
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    id: 's-test',
    page: {
      url: 'https://example.com/shop',
      urlRedacted: false,
      title: '테스트 페이지',
      collectedAt: '2026-10-06T10:00:00.000Z',
      viewport: { innerWidth: 1280, innerHeight: 800, clientWidth: 1280, clientHeight: 800, dpr: 2 },
      scroll: { x: 0, y: 0 },
      document: {
        scrollWidth: 1280,
        scrollHeight: 2000,
        clientWidth: 1280,
        clientHeight: 800,
        hasHorizontalOverflow: false,
        hasVerticalOverflow: true,
        compatMode: 'CSS1Compat',
      },
    },
    targetId: target?.id ?? 'E1',
    elements,
    limits: DEFAULT_LIMITS,
    omitted: { ancestors: 0, children: 0, siblings: 0, offenders: 0, scanSkipped: 0 },
    limitations: [],
    ...overrides,
  };
}

export function stored(snap: Snapshot, conversationId = 'c1'): StoredSnapshot {
  return {
    ...snap,
    conversationId,
    source: { tabId: 1, frameId: 0, documentId: 'doc-1' },
    exclusions: { ...NO_EXCLUSIONS, elementIds: [] },
    savedAt: 1,
  };
}

/** SSE 본문을 조각으로 나눠 흘려 보내는 Response */
export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

/** 일부를 보낸 뒤 오류로 끊기는 스트림 */
export function brokenSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]!));
      } else {
        controller.error(new TypeError('network error'));
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
