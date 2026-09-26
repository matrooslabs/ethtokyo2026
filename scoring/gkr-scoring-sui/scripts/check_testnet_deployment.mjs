import { readFileSync } from 'node:fs';
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const at = process.argv.indexOf('--manifest');
if (at < 0 || !process.argv[at + 1]) throw new Error('Pass --manifest PATH from a confirmed preparation');
const manifest = JSON.parse(readFileSync(process.argv[at + 1], 'utf8'));
if (manifest.network !== 'testnet' || !manifest.packageId || !manifest.registryId || !manifest.organizerCapId) {
  throw new Error('Not a prepared Sui testnet Forest manifest');
}
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: manifest.rpc });
const [pkg, registry, cap, coin, gas] = await Promise.all([
  client.getObject({ objectId: manifest.packageId }),
  client.getObject({ objectId: manifest.registryId, include: { json: true } }),
  client.getObject({ objectId: manifest.organizerCapId, include: { json: true } }),
  client.getCoinMetadata({ coinType: manifest.asset }),
  client.getBalance({ owner: manifest.organizer }),
]);
const reg = registry.object?.json;
const expectedSrsId = Buffer.from(manifest.srsId.slice(2), 'hex').toString('base64');
if (pkg.object?.objectId !== manifest.packageId || pkg.object.type !== 'package' ||
    registry.object?.objectId !== manifest.registryId ||
    registry.object.type !== `${manifest.packageId}::registry::Registry` ||
    cap.object?.objectId !== manifest.organizerCapId ||
    cap.object.owner?.AddressOwner !== manifest.organizer ||
    cap.object.json?.registry !== manifest.registryId ||
    reg?.vk?.id !== expectedSrsId || reg?.charts?.size !== '2' ||
    coin.coinMetadata?.symbol !== 'USDC' || coin.coinMetadata.decimals !== 6) {
  throw new Error('Published Sui package, Registry, organizer cap, SRS, chart count or USDC metadata does not match the manifest');
}
const fields = await client.listDynamicFields({ parentId: reg.charts.id, limit: 10 });
const registered = fields.dynamicFields.map((field) => {
  if (field.name.type !== 'vector<u8>' ||
      field.valueType !== `${manifest.packageId}::verifier::ChartRecord`) {
    throw new Error('Registry contains an unexpected chart field type');
  }
  return { hash: `0x${Buffer.from(bcs.vector(bcs.u8()).parse(field.name.bcs)).toString('hex')}`, fieldId: field.fieldId };
});
const expected = [manifest.charts.easy.chartHash, manifest.charts.hard.chartHash].sort();
if (registered.length !== 2 || registered.map(({ hash }) => hash).sort().some((hash, index) => hash !== expected[index])) {
  throw new Error('On-chain chart dynamic fields differ from prepared Easy/Hard Forest hashes');
}
const receipts = await Promise.all(['easy', 'hard'].map(async (difficulty) => {
  const digest = manifest.charts[difficulty].registrationTx;
  const { Transaction: tx } = await client.waitForTransaction({ digest, include: { effects: true, events: true } });
  if (!tx?.effects?.status?.success || !tx.events?.some((event) => event.eventType.endsWith('::registry::ChartRegistered'))) {
    throw new Error(`${difficulty} chart transaction is not confirmed with a ChartRegistered event`);
  }
  return { difficulty, digest, hash: manifest.charts[difficulty].chartHash };
}));
console.log(JSON.stringify({
  network: manifest.network, packageId: manifest.packageId, registryId: manifest.registryId,
  srsId: manifest.srsId, srsSecurity: manifest.srsSecurity,
  chartCount: reg.charts.size, deviceCount: reg.devices.size,
  registered, receipts,
  usdc: { type: manifest.asset, symbol: coin.coinMetadata.symbol, decimals: coin.coinMetadata.decimals },
  organizer: manifest.organizer, gasMist: gas.balance.balance,
  challengeId: manifest.challengeId ?? null,
}, null, 2));
