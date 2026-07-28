export class RuntimeRecoveryBarrier {
  private activeListeners = 0;
  private recoveryActive = false;
  private readonly listenerWaiters: Array<() => void> = [];
  private readonly recoveryWaiters: Array<() => void> = [];

  async runListener<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireListener();
    try {
      return await operation();
    } finally {
      this.releaseListener();
    }
  }

  async runRecovery<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireRecovery();
    try {
      return await operation();
    } finally {
      this.releaseRecovery();
    }
  }

  private async acquireListener(): Promise<void> {
    if (!this.recoveryActive && this.recoveryWaiters.length === 0) {
      this.activeListeners += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.listenerWaiters.push(resolve);
    });
  }

  private releaseListener(): void {
    this.activeListeners -= 1;
    if (this.activeListeners === 0) this.startNextRecovery();
  }

  private async acquireRecovery(): Promise<void> {
    if (!this.recoveryActive && this.activeListeners === 0) {
      this.recoveryActive = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.recoveryWaiters.push(resolve);
    });
  }

  private releaseRecovery(): void {
    this.recoveryActive = false;
    if (this.recoveryWaiters.length > 0) {
      this.startNextRecovery();
      return;
    }
    const listeners = this.listenerWaiters.splice(0);
    this.activeListeners += listeners.length;
    for (const resolve of listeners) resolve();
  }

  private startNextRecovery(): void {
    if (this.recoveryActive || this.activeListeners > 0) return;
    const resolve = this.recoveryWaiters.shift();
    if (!resolve) return;
    this.recoveryActive = true;
    resolve();
  }
}
