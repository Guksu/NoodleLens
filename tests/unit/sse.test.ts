import { describe, expect, it } from 'vitest';
import { readSse, SseParser } from '../../src/providers/sse';
import { collect, sseResponse } from './fixtures';

describe('SseParser', () => {
  it('조각 경계가 줄·이벤트 중간에 걸려도 이벤트를 온전히 나눈다', () => {
    const parser = new SseParser();
    const text = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\n';
    const events = [];
    for (const char of text) events.push(...parser.push(char));
    events.push(...parser.flush());
    expect(events).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'b', data: '{"y":2}' },
    ]);
  });

  it('CRLF와 \\r만 있는 줄 끝을 처리하고, \\r 뒤 \\n이 다음 조각에 와도 줄을 두 번 나누지 않는다', () => {
    const parser = new SseParser();
    const first = parser.push('data: one\r');
    const second = parser.push('\n\r\ndata: two\r\rdata: three\n\n');
    expect([...first, ...second, ...parser.flush()]).toEqual([
      { event: 'message', data: 'one' },
      { event: 'message', data: 'two' },
      { event: 'message', data: 'three' },
    ]);
  });

  it('여러 data 줄은 줄바꿈으로 합치고 주석 줄은 무시한다', () => {
    const parser = new SseParser();
    const events = parser.push(': keep-alive\ndata: line1\ndata: line2\n\n');
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('마지막 빈 줄 없이 끝난 이벤트는 flush에서 내보낸다', () => {
    const parser = new SseParser();
    expect(parser.push('event: done\ndata: {}')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: 'done', data: '{}' }]);
  });
});

describe('readSse', () => {
  it('응답 본문을 이벤트로 읽는다', async () => {
    const response = sseResponse(['event: a\nda', 'ta: 1\n\n', 'event: b\ndata: 2\n\n']);
    const events = await collect(readSse(response.body!, new AbortController().signal));
    expect(events.map((e) => e.event)).toEqual(['a', 'b']);
  });

  it('abort하면 AbortError로 멈춘다', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: 1\n\n'));
      },
    });
    const iterator = readSse(stream, controller.signal);
    const first = await iterator.next();
    expect(first.value).toEqual({ event: 'message', data: '1' });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
