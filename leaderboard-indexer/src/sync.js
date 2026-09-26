export class Indexer {
  constructor(store, source, { confirmations = 2, batchSize = 100 } = {}) {
    this.store = store;
    this.source = source;
    this.confirmations = confirmations;
    this.batchSize = batchSize;
    this.state = { headBlock: null, targetBlock: null, syncing: false, lastSyncedAt: null,
      lastError: null, reconciliation: { status: 'not_checked' } };
  }
  status() {
    const tip = this.store.tip();
    return { ...this.store.identity, deploymentBlock: String(this.store.identity.deploymentBlock),
      chainId: String(this.store.identity.chainId), ...this.state,
      indexedBlock: tip ? String(tip.number) : null, indexedBlockHash: tip?.hash ?? null,
      confirmations: this.confirmations,
      lag: this.state.targetBlock === null ? null : String(Math.max(0, Number(this.state.targetBlock) - (tip?.number ?? Number(this.store.identity.deploymentBlock) - 1))),
    };
  }
  async sync() {
    if (this.state.syncing) throw new Error('Sync already running');
    this.state.syncing = true;
    this.state.lastError = null;
    this.state.reconciliation = { status: 'not_checked' };
    try {
      const head = await this.source.head();
      if (!Number.isSafeInteger(head) || head < 0) throw new Error('Invalid chain head');
      const target = head - this.confirmations;
      this.state.headBlock = String(head);
      this.state.targetBlock = String(target);
      const deployment = Number(this.store.identity.deploymentBlock);
      let ancestor = this.store.tip();
      while (ancestor) {
        if (ancestor.number <= target) {
          const canonical = await this.source.block(ancestor.number);
          if (canonical.hash === ancestor.hash) break;
        }
        ancestor = this.store.block(ancestor.number - 1);
      }
      const ancestorNumber = ancestor?.number ?? deployment - 1;
      if (this.store.tip() && this.store.tip().number > ancestorNumber) this.store.rollback(ancestorNumber);
      for (let from = ancestorNumber + 1; from <= target; from += this.batchSize) {
        const to = Math.min(from + this.batchSize - 1, target);
        const logs = await this.source.events(from, to);
        const byBlock = new Map();
        for (const event of logs) {
          const number = Number(event.position.blockNumber);
          if (number < from || number > to) throw new Error('RPC returned out-of-range event');
          if (!byBlock.has(number)) byBlock.set(number, []);
          byBlock.get(number).push(event);
        }
        const blocks = [];
        for (let number = from; number <= to; number++) {
          const block = await this.source.block(number);
          const events = byBlock.get(number) ?? [];
          if (events.some(e => e.position.blockHash !== block.hash)) throw new Error('Chain changed while fetching logs');
          blocks.push({ ...block, number, events });
        }
        // Pin the entire contiguous batch to a canonical tip before committing.
        if ((await this.source.block(to)).hash !== blocks.at(-1).hash) throw new Error('Chain changed while fetching blocks');
        this.store.append(blocks);
      }
      const tip = this.store.tip();
      if (tip && this.source.reconcile) {
        this.state.reconciliation = await this.source.reconcile(this.store.view, tip);
        if ((await this.source.block(tip.number)).hash !== tip.hash) throw new Error('Chain changed during reconciliation');
        if (this.state.reconciliation.status !== 'ok') throw new Error('Contract reconciliation failed; see reconciliation status');
      }
      this.state.lastSyncedAt = new Date().toISOString();
    } catch (error) {
      this.state.lastError = error.message;
      throw error;
    } finally { this.state.syncing = false; }
    return this.status();
  }
}
