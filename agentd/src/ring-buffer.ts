import type { AgentEvent, AgentEventType } from "./types.js"

/**
 * Per-session event log (§5.1): monotonic `seq`, bounded by both event count
 * and total bytes. Reconnecting clients replay from `?after=<seq>`; if the
 * requested range has been evicted the caller learns via `oldestSeq`.
 */
export class EventBuffer {
  private events: AgentEvent[] = []
  private bytes = 0
  private nextSeq = 1

  constructor(
    private maxEvents: number,
    private maxBytes: number,
  ) {}

  append(type: AgentEventType, payload: Record<string, unknown>, ts = Date.now()): AgentEvent {
    const ev: AgentEvent = { seq: this.nextSeq++, ts, type, payload }
    const size = JSON.stringify(ev).length
    this.events.push(ev)
    this.bytes += size
    while (
      this.events.length > 0 &&
      (this.events.length > this.maxEvents || this.bytes > this.maxBytes)
    ) {
      const dropped = this.events.shift()!
      this.bytes -= JSON.stringify(dropped).length
    }
    return ev
  }

  /** Events with seq > after, in order. */
  since(after: number): AgentEvent[] {
    // events are contiguous and sorted; binary search not worth it at 5k cap
    return this.events.filter((e) => e.seq > after)
  }

  get latestSeq(): number {
    return this.nextSeq - 1
  }

  /** Smallest seq still held (latestSeq + 1 when empty). */
  get oldestSeq(): number {
    return this.events.length ? this.events[0]!.seq : this.nextSeq
  }

  get size(): number {
    return this.events.length
  }
}
