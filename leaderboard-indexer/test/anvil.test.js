import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { Store } from '../src/store.js';
import { ChainSource, normalizeLog } from '../src/chain.js';
import { Indexer } from '../src/sync.js';
import { json, roundKey } from '../src/domain.js';

const artifact = (folder, name) => JSON.parse(readFileSync(new URL(`../../scoring/gkr-scoring/contracts/out/${folder}/${name}.json`, import.meta.url), 'utf8'));

test('Anvil: actual deployed ABI, RPC backfill/reconciliation, settlement, reorg, restart and replay', {
  skip: process.env.RUN_ANVIL_TESTS !== '1' && 'Set RUN_ANVIL_TESTS=1 after building Solidity artifacts', timeout: 60000,
}, async t => {
  const port = process.env.ANVIL_PORT ?? '19547';
  const processHandle = spawn('anvil', ['--host', '127.0.0.1', '--port', port, '--silent'], { stdio: 'ignore' });
  let spawnError;
  processHandle.on('error', error => { spawnError = error; });
  t.after(() => { processHandle.kill('SIGTERM'); });
  const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 1000 });
  const client = createPublicClient({ chain: foundry, transport, cacheTime: 0, pollingInterval: 10 });
  const wallet = createWalletClient({ chain: foundry, transport });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (spawnError) throw spawnError;
    if (processHandle.exitCode !== null) throw new Error('Isolated Anvil failed to start (port may be in use)');
    try { await client.getChainId(); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, 'Anvil ready');
  const [alice, bob] = await wallet.getAddresses();
  const receipt = async hash => {
    const value = await client.waitForTransactionReceipt({ hash });
    assert.equal(value.status, 'success');
    return value;
  };
  const deploy = async (a, args = []) => receipt(await wallet.deployContract({ account: alice, abi: a.abi, bytecode: a.bytecode.object, args }));
  const write = async (address, a, name, args, account = alice) => receipt(await wallet.writeContract({ account, address, abi: a.abi, functionName: name, args }));
  const tokenArtifact = artifact('DailyLeaderboard.t.sol', 'TestUSDC');
  const registryArtifact = artifact('DailyLeaderboard.t.sol', 'MockPaidRegistry');
  const boardArtifact = artifact('DailyLeaderboard.sol', 'DailyLeaderboard');
  const token = (await deploy(tokenArtifact)).contractAddress;
  const registry = (await deploy(registryArtifact)).contractAddress;
  const deployed = await deploy(boardArtifact, [token, registry]);
  const board = deployed.contractAddress;
  await write(token, tokenArtifact, 'mint', [alice, 10000000n]);
  await write(token, tokenArtifact, 'approve', [board, 10000000n]);
  const chart = `0x${'01'.repeat(32)}`, refundChart = `0x${'02'.repeat(32)}`;
  const day = (await client.getBlock()).timestamp / 86400n;
  const enter = async (chartHash, player) => {
    const paid = await write(board, boardArtifact, 'enter', [chartHash, player, alice, day]);
    return paid.logs.filter(log => log.address.toLowerCase() === board.toLowerCase()).map(normalizeLog).find(e => e.type === 'entry').sessionId;
  };
  const first = await enter(chart, alice);
  const second = await enter(chart, bob);
  const third = await enter(chart, alice);
  await enter(refundChart, bob);
  const snapshot = await client.request({ method: 'evm_snapshot' });
  await write(registry, registryArtifact, 'record', [board, first, 0]);
  await write(registry, registryArtifact, 'record', [board, second, 100]);
  await write(registry, registryArtifact, 'record', [board, third, 100]);
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number((day + 1n) * 86400n)] });
  await write(board, boardArtifact, 'claim', [chart, day]);
  await write(board, boardArtifact, 'refund', [refundChart, day]);
  const dir = mkdtempSync(join(tmpdir(), 'leaderboard-anvil-'));
  const path = join(dir, 'chain.sqlite');
  const identity = { chainId: '31337', address: board.toLowerCase(), deploymentBlock: deployed.blockNumber.toString() };
  let store = new Store(path, identity);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = new ChainSource(client, board);
  let indexer = new Indexer(store, source, { confirmations: 0, batchSize: 4 });
  await indexer.sync();
  assert.equal(indexer.status().reconciliation.status, 'ok');
  let round = store.view.rounds.get(roundKey(chart, day));
  assert.equal(round.leader.player, bob.toLowerCase());
  assert.equal(round.pot, '3000000');
  assert.equal(round.claimed, true);
  assert.equal(store.view.charts.get(refundChart).totalRefunds, '1000000');
  const expected = json(store.events());
  await indexer.sync();
  assert.equal(json(store.events()), expected);
  store.close();
  store = new Store(path, identity);
  indexer = new Indexer(store, source, { confirmations: 0, batchSize: 4 });
  await indexer.sync();
  assert.equal(json(store.events()), expected);
  store.rebuild();
  await indexer.sync();
  assert.equal(json(store.events()), expected);
  assert.equal(await client.request({ method: 'evm_revert', params: [snapshot] }), true);
  await write(registry, registryArtifact, 'record', [board, first, 7]);
  await indexer.sync();
  round = store.view.rounds.get(roundKey(chart, day));
  assert.equal(round.leader.player, alice.toLowerCase());
  assert.equal(round.claimed, false);
  assert.equal(round.remainingPot, '3000000');
  assert.equal(store.view.charts.get(refundChart).totalRefunds, '0');
  assert.equal(store.view.charts.get(refundChart).remainingPot, '1000000');
  assert.equal(store.view.settlements.length, 0);
  assert.equal(indexer.status().reconciliation.status, 'ok');
});
