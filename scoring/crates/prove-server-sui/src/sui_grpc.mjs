// Read-only Sui gRPC adapter. Uses the same pinned SDK as the Sui localnet/testnet
// integration script. Outputs one normalized on-chain snapshot for the Rust bridge.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(process.env.SUI_SDK_MANIFEST ??
  new URL('../../../gkr-scoring-sui/scripts/package.json', import.meta.url));
const [{ SuiGrpcClient }, { bcs }] = await Promise.all([
  import(pathToFileURL(require.resolve('@mysten/sui/grpc')).href),
  import(pathToFileURL(require.resolve('@mysten/sui/bcs')).href),
]);

const [url, network, sessionId, registryId, packageId] = process.argv.slice(2);
if (!url || !network || !sessionId || !registryId || !packageId) {
  throw new Error('usage: sui_grpc.mjs URL NETWORK SESSION_ID REGISTRY_ID PACKAGE_ID');
}
const client = new SuiGrpcClient({ baseUrl: url, network });
const expectedType = (module, name) => `${packageId}::${module}::${name}`;

async function object(id, type) {
  const { object } = await client.getObject({ objectId: id, include: { json: true } });
  if (object.type !== expectedType('registry', type) || !object.json) throw new Error(`wrong or unavailable ${type}`);
  return object.json;
}
function wire(value, length) {
  if (typeof value !== 'string') throw new Error('missing on-chain byte field');
  const bytes = value.startsWith('0x')
    ? Buffer.from(value.slice(2), 'hex') : Buffer.from(value, 'base64');
  if (bytes.length !== length) throw new Error(`expected ${length} on-chain bytes`);
  return `0x${bytes.toString('hex')}`;
}
const sid = await object(sessionId, 'Session');
if (sid.registry !== registryId) throw new Error('Session belongs to another Registry');
const reg = await object(registryId, 'Registry');
const header = sid.header;
const device = wire(header.device, 20);
const chart = wire(header.chart_hash, 32);

async function dynamicValue(tableId, name, type) {
  const { dynamicField } = await client.getDynamicField({
    parentId: tableId,
    name: { type: 'vector<u8>', bcs: bcs.vector(bcs.u8()).serialize([...Buffer.from(name.slice(2), 'hex')]).toBytes() },
  });
  if (dynamicField.value.type !== expectedType(type === 'ChartRecord' ? 'verifier' : 'registry', type))
    throw new Error(`wrong ${type} field type`);
  const { object } = await client.getObject({ objectId: dynamicField.fieldId, include: { json: true } });
  if (!object.json?.value) throw new Error(`missing ${type} field`);
  return object.json.value;
}
const [dev, chartRecord] = await Promise.all([
  dynamicValue(reg.devices.id, device, 'Device'),
  dynamicValue(reg.charts.id, chart, 'ChartRecord'),
]);
const normalizedHeader = { chain_id: header.chain_id };
for (const [key, size] of Object.entries({
  verifier: 20, match_id: 32, session_id: 32, challenge: 32, player: 20,
  device: 20, chart_hash: 32, ruleset_id: 32, bitstream_hash: 32, input_policy_hash: 32,
})) normalizedHeader[key] = wire(header[key], size);
console.log(JSON.stringify({
  session: { ...sid, header: { fields: normalizedHeader } },
  registry: {
    chain_id: reg.chain_id, verifier_tag: wire(reg.verifier_tag, 20),
    vk: { fields: { id: wire(reg.vk.id, 32), smax: reg.vk.smax } },
  },
  device: { fields: {
    active: dev.active, pubkey: wire(dev.pubkey, 33), bitstream_hash: wire(dev.bitstream_hash, 32),
  } },
  chart: { fields: {
    commitment: wire(chartRecord.commitment, 48), m: chartRecord.m, bits: chartRecord.bits,
    components: chartRecord.components, max_end: chartRecord.max_end,
  } },
}));
