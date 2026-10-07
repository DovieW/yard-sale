// A capture and its request share one reservation. Reset invalidates results from
// a replaced source, without allowing its pending request to overlap a new one.
export class ScanWork {
  private generation = 0;
  private busy = false;
  acquire(): number | null {
    if (this.busy) return null;
    this.busy = true;
    return this.generation;
  }
  isCurrent(token: number): boolean { return token === this.generation; }
  invalidate(): void { this.generation += 1; }
  release(): void { this.busy = false; }
}
