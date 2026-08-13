export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async drained(): Promise<void> {
    await this.tail;
  }
}

export class ActiveTurnSlots {
  private readonly owners = new Set<string>();

  constructor(readonly limit = 3) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Slot limit must be a positive integer");
  }

  get active(): number {
    return this.owners.size;
  }

  reserve(owner: string): void {
    if (this.owners.has(owner)) throw new Error(`Active turn slot ${owner} is already reserved`);
    if (this.owners.size >= this.limit) {
      throw new Error(`Capacity error: all ${this.limit} child turn slots are active`);
    }
    this.owners.add(owner);
  }

  release(owner: string): boolean {
    return this.owners.delete(owner);
  }

  has(owner: string): boolean {
    return this.owners.has(owner);
  }

  clear(): void {
    this.owners.clear();
  }
}
