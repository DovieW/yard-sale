import type { Stats } from "./types";

export const DEFAULT_MAX_CONCURRENT_FRAMES = 5;
export const MAX_CONCURRENT_FRAMES_SETTING = 100;

// Each capture keeps its own slot through encoding and analysis. Source changes
// invalidate old results; their slots remain reserved until that work settles.
export class ScanWork {
  private generation = 0;
  private sequence = 0;
  private active = new Map<number, number>();
  acquire(limit = DEFAULT_MAX_CONCURRENT_FRAMES): number | null {
    if (this.active.size >= limit) return null;
    const token = ++this.sequence;
    this.active.set(token, this.generation);
    return token;
  }
  isCurrent(token: number): boolean { return this.active.get(token) === this.generation; }
  invalidate(): void { this.generation += 1; }
  release(token: number): void { this.active.delete(token); }
}

export function mergeProcessingStats(current: Stats, incoming: Stats): Stats {
  return {
    framesProcessed: Math.max(current.framesProcessed, incoming.framesProcessed),
    itemsIdentified: Math.max(current.itemsIdentified, incoming.itemsIdentified),
    searchesPerformed: Math.max(current.searchesPerformed, incoming.searchesPerformed),
    modelCalls: Math.max(current.modelCalls, incoming.modelCalls),
    lastUpdated: [current.lastUpdated, incoming.lastUpdated].filter((value): value is string => value !== null).sort().at(-1) ?? null,
  };
}
