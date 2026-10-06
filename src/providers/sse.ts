/**
 * Server-Sent Events 파서. fetch 응답 본문을 조각 단위로 받아 이벤트로 나눈다.
 * 조각 경계가 줄·이벤트 중간에 걸려도 되고, CRLF/LF를 모두 처리한다.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let index: number;
    while ((index = this.findLineEnd()) >= 0) {
      const line = this.buffer.slice(0, index);
      const skip = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(index + skip);
      const event = this.consumeLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** 스트림이 끝났을 때 남은 줄을 처리한다 */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const event = this.consumeLine(this.buffer);
      this.buffer = '';
      if (event) events.push(event);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private findLineEnd(): number {
    const cr = this.buffer.indexOf('\r');
    const lf = this.buffer.indexOf('\n');
    if (cr < 0) return lf;
    if (lf < 0) {
      // 마지막 문자가 \r이면 다음 조각의 \n을 기다린다.
      return cr === this.buffer.length - 1 ? -1 : cr;
    }
    return Math.min(cr, lf);
  }

  private consumeLine(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return null;
    }
    const event = { event: this.eventName || 'message', data: this.dataLines.join('\n') };
    this.eventName = '';
    this.dataLines = [];
    return event;
  }
}

/** 응답 본문을 SSE 이벤트로 읽는다. signal abort 시 reader를 닫고 AbortError를 던진다. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    for (const event of parser.push(decoder.decode())) yield event;
    for (const event of parser.flush()) yield event;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
