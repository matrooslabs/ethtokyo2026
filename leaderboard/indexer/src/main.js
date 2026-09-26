import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicClient, http } from 'viem';
import { configFromEnv } from './config.js';
import { Store } from './store.js';
import { ChainSource } from './chain.js';
import { Indexer } from './sync.js';
import { createApi } from './api.js';
import { json } from './domain.js';

let store, server, timer, stopping = false, indexer;
// viem errors may include the RPC URL (including a provider credential).
function safeError(error, rpcUrl) {
  let message = error.shortMessage ?? error.message ?? 'Unknown error';
  if (rpcUrl) message = message.split(rpcUrl).join('[RPC_URL]');
  return message.replace(/https?:\/\/[^\s"'<>]+/g, '[RPC_URL]');
}
async function main() {
  const config = configFromEnv();
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) if (!['--once', '--rebuild'].includes(flag)) throw new Error(`Unknown argument ${flag}`);
  if (flags.has('--rebuild') && !flags.has('--once')) throw new Error('--rebuild requires --once; stop the running indexer first');
  const client = createPublicClient({ transport: http(config.rpcUrl, { timeout: 15000, retryCount: 2 }), cacheTime: 0 });
  // Validate deployment identity before opening or clearing any database.
  if (String(await client.getChainId()) !== config.identity.chainId) throw new Error('RPC chain ID does not match CHAIN_ID');
  const code = await client.getCode({ address: config.identity.address, blockNumber: BigInt(config.identity.deploymentBlock) });
  if (!code || code === '0x') throw new Error('No contract at LEADERBOARD_ADDRESS in DEPLOYMENT_BLOCK; verify deployment configuration');
  mkdirSync(dirname(config.dbPath), { recursive: true });
  store = new Store(config.dbPath, config.identity, config.metadata);
  indexer = new Indexer(store, new ChainSource(client, config.identity.address), config);
  if (flags.has('--rebuild')) store.rebuild();
  if (flags.has('--once')) {
    await indexer.sync();
    console.log(json(indexer.status()));
    store.close(); store = null;
    return;
  }
  server = createApi(indexer, config);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  console.log(`Leaderboard API listening on ${config.host}:${config.port}`);
  const poll = async () => {
    try { await indexer.sync(); }
    catch (error) { indexer.state.lastError = safeError(error, config.rpcUrl); console.error(indexer.state.lastError); }
    finally {
      if (stopping) { store.close(); store = null; }
      else timer = setTimeout(poll, config.pollMs);
    }
  };
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
    server.close();
    if (!indexer.state.syncing && store) { store.close(); store = null; }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await poll();
}
main().catch(error => {
  console.error(safeError(error, process.env.RPC_URL));
  server?.close();
  store?.close();
  process.exitCode = 1;
});
