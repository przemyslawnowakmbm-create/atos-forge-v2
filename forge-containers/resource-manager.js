#!/usr/bin/env node
'use strict';

const { resolveConfig, formatMemory } = require('./config');

// ============================================================
// Semaphore — Bounded concurrency for container slots
// ============================================================

class ResourceManager {
  /**
   * @param {string} cwd - Project root for config loading.
   */
  constructor(cwd) {
    this.cwd = cwd;
    this.config = resolveConfig(cwd);
    this.maxSlots = this.config.max_concurrent;
    this.activeSlots = 0;
    this._queue = []; // Pending acquire callbacks
    this._containers = new Map(); // id → { acquired_at, memory, cpu }
  }

  /**
   * Acquire a resource slot. Resolves when a slot is available.
   * @param {string} id - Container identifier.
   * @param {{ memory?: number, cpu?: number }} opts - Resource request.
   * @returns {Promise<{ slot: number, id: string }>}
   */
  acquire(id, opts = {}) {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.activeSlots < this.maxSlots) {
          this.activeSlots++;
          const slot = this.activeSlots;
          this._containers.set(id, {
            slot,
            acquired_at: Date.now(),
            memory: opts.memory || this.config.max_memory_per_container,
            cpu: opts.cpu || this.config.max_cpu_per_container,
          });
          resolve({ slot, id });
          return true;
        }
        return false;
      };

      if (!tryAcquire()) {
        this._queue.push({ id, opts, resolve: tryAcquire, callback: resolve });
      }
    });
  }

  /**
   * Release a resource slot.
   * @param {string} id - Container identifier.
   */
  release(id) {
    if (!this._containers.has(id)) return;
    this._containers.delete(id);
    this.activeSlots = Math.max(0, this.activeSlots - 1);

    // Process waiting queue
    while (this._queue.length > 0 && this.activeSlots < this.maxSlots) {
      const pending = this._queue.shift();
      this.activeSlots++;
      const slot = this.activeSlots;
      this._containers.set(pending.id, {
        slot,
        acquired_at: Date.now(),
        memory: pending.opts.memory || this.config.max_memory_per_container,
        cpu: pending.opts.cpu || this.config.max_cpu_per_container,
      });
      pending.callback({ slot, id: pending.id });
    }
  }

  /**
   * Current resource status.
   */
  status() {
    const containers = [];
    for (const [id, info] of this._containers) {
      containers.push({
        id,
        slot: info.slot,
        memory: formatMemory(info.memory),
        cpu: info.cpu,
        uptime_ms: Date.now() - info.acquired_at,
      });
    }

    const totalMemUsed = [...this._containers.values()]
      .reduce((sum, c) => sum + c.memory, 0);
    const totalCpuUsed = [...this._containers.values()]
      .reduce((sum, c) => sum + c.cpu, 0);

    return {
      max_slots: this.maxSlots,
      active: this.activeSlots,
      available: this.maxSlots - this.activeSlots,
      queued: this._queue.length,
      total_memory_used: formatMemory(totalMemUsed),
      total_memory_limit: this.config.max_total_memory_str,
      total_cpu_used: totalCpuUsed.toFixed(1),
      total_cpu_limit: this.config.max_total_cpu,
      containers,
    };
  }

  /**
   * Whether slots are available without waiting.
   */
  hasCapacity() {
    return this.activeSlots < this.maxSlots;
  }

  /**
   * Force-release all slots (for cleanup on error).
   */
  releaseAll() {
    for (const id of this._containers.keys()) {
      this.release(id);
    }
    this._queue = [];
    this.activeSlots = 0;
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = { ResourceManager };
