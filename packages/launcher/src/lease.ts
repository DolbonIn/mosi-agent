/** Per-user FIFO mutex: one running turn per user; messages sent meanwhile are steered into it. */

export interface Lease {
  release(): void;
  steer(text: string): void;
  drain(): string[];
  /** queued steered messages, without draining them (TurnInput.steerPending) */
  pending(): number;
}

const MAX_QUEUED = 20;
const MAX_STEER_CHARS = 4000;

class ActiveLease implements Lease {
  #queue: string[];
  #released = false;
  constructor(
    private readonly onRelease: (l: ActiveLease, leftover: string[]) => void,
    initial: string[] = [],
  ) {
    this.#queue = initial.slice(-MAX_QUEUED);
  }

  get released(): boolean {
    return this.#released;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    const leftover = this.#queue;
    this.#queue = [];
    this.onRelease(this, leftover);
  }

  steer(text: string): void {
    if (this.#released) return;
    const t = typeof text === "string" ? text.trim().slice(0, MAX_STEER_CHARS) : "";
    if (!t) return;
    this.#queue.push(t);
    if (this.#queue.length > MAX_QUEUED) this.#queue.shift();
  }

  drain(): string[] {
    const q = this.#queue;
    this.#queue = [];
    return q;
  }

  pending(): number {
    return this.#released ? 0 : this.#queue.length;
  }
}

interface UserLock {
  held: ActiveLease | null;
  waiters: ((l: ActiveLease) => void)[];
}

export class LeaseManager {
  #locks = new Map<string, UserLock>();
  /** steered messages nobody drained before release; handed to the next lease's first drain() */
  #carry = new Map<string, string[]>();

  constructor(
    private readonly hooks: { onAcquire(userId: string): void; onRelease(userId: string): void },
  ) {}

  #lock(userId: string): UserLock {
    let l = this.#locks.get(userId);
    if (!l) {
      l = { held: null, waiters: [] };
      this.#locks.set(userId, l);
    }
    return l;
  }

  #grant(userId: string, lock: UserLock): ActiveLease {
    const carried = this.#carry.get(userId) ?? [];
    this.#carry.delete(userId);
    const lease = new ActiveLease((l, leftover) => {
      if (lock.held !== l) return;
      lock.held = null;
      if (leftover.length) this.#carry.set(userId, [...(this.#carry.get(userId) ?? []), ...leftover].slice(-MAX_QUEUED));
      this.hooks.onRelease(userId);
      const next = lock.waiters.shift();
      if (next) next(this.#grant(userId, lock));
      else this.#locks.delete(userId);
    }, carried);
    lock.held = lease;
    this.hooks.onAcquire(userId);
    return lease;
  }

  acquire(userId: string): Promise<Lease> {
    const lock = this.#lock(userId);
    if (!lock.held && lock.waiters.length === 0) return Promise.resolve(this.#grant(userId, lock));
    return new Promise<Lease>((resolve) => lock.waiters.push(resolve));
  }

  tryAcquire(userId: string): Lease | null {
    const lock = this.#lock(userId);
    if (lock.held || lock.waiters.length) return null;
    return this.#grant(userId, lock);
  }

  steer(userId: string, text: string): boolean {
    const held = this.#locks.get(userId)?.held;
    if (!held || held.released) return false;
    held.steer(text);
    return true;
  }

  isHeld(userId: string): boolean {
    return !!this.#locks.get(userId)?.held;
  }

  /** take (and clear) steered messages the last lease never drained */
  takeLeftover(userId: string): string[] {
    const left = this.#carry.get(userId) ?? [];
    this.#carry.delete(userId);
    return left;
  }

  waiting(userId: string): number {
    return this.#locks.get(userId)?.waiters.length ?? 0;
  }
}
