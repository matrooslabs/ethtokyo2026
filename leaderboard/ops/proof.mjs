import { toHex, sha256, concat, encodePacked, recoverAddress } from 'viem';
export const headerFields=[['chainId','uint64'],['verifier','address'],['matchId','bytes32'],['sessionId','bytes32'],['challenge','bytes32'],['player','address'],['device','address'],['chartHash','bytes32'],['rulesetId','bytes32'],['bitstreamHash','bytes32'],['inputPolicyHash','bytes32']];
export function rustHeader(h){return Object.fromEntries(headerFields.map(([name,type])=>[name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),type==='uint64'?Number(h[name]):[...Buffer.from(h[name].slice(2),'hex')]]));}
export function eventBytes(events){return events.length ? concat(events.map(e=>encodePacked(['uint32','uint64','uint8','uint8'],[e.sequence,BigInt(e.timestamp_us),e.lane,e.action]))) : '0x';}
export function traceRoot(id,events){let root=sha256(concat([toHex('OSUMANIA_TRACE_V1'),id]));for(let i=0;i<events.length;i+=32){const chunk=events.slice(i,i+32);root=sha256(concat([root,encodePacked(['uint32','uint16'],[i/32,chunk.length]),eventBytes(chunk)]));}return root;}
export function sessionDigest(h,n,duration,root){return sha256(concat([toHex('OSUMANIA_HARDWARE_SESSION_V1'),toHex(1,{size:2}),encodePacked(headerFields.map(([,t])=>t),headerFields.map(([n,t])=>t==='uint64'?BigInt(h[n]):h[n])),encodePacked(['uint32','uint64','bytes32'],[n,BigInt(duration),root])]));}
const word = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
function checkSrs(actual, expected) {
 if (!word(actual) || !word(expected) || actual.toLowerCase() !== expected.toLowerCase()) throw Error('Scoring server SRS does not match deployment');
}
async function scoringRequest({url,token,signal}, route, body, timeoutMs) {
 const endpoint = new URL(`${url.replace(/\/$/, '')}${route}`);
 if (!['http:', 'https:'].includes(endpoint.protocol)) throw Error('Scoring server URL must use HTTP(S)');
 const timeout = AbortSignal.timeout(timeoutMs);
 const response = await fetch(endpoint, {
  method: body ? 'POST' : 'GET',
  headers: {'content-type':'application/json', ...(token ? {authorization:`Bearer ${token}`} : {})},
  body: body ? JSON.stringify(body) : undefined,
  signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  redirect: 'error',
 });
 if (!response.ok) throw Error(`Scoring server HTTP ${response.status}`);
 try { return await response.json(); } catch { throw Error('Invalid scoring server JSON'); }
}
export async function proverInfo({url,token,expectedSrsId,signal}) {
 const info = await scoringRequest({url,token,signal}, '/v1/info', undefined, 10000);
 if (info?.system !== 'gkr' || !info.modes?.includes('calldata')) throw Error('Scoring server must support EVM calldata proofs');
 checkSrs(info.srsId, expectedSrsId);
 return info;
}
export async function prove({url,token,expectedSrsId,input,header,sealed=false,signal}) {
 // Rebinding is only for software demo input. Hardware seals remain byte-for-byte intact.
 const play = structuredClone(input);
 const canonical = rustHeader(header);
 if (sealed) {
  if (Object.keys(canonical).some(k => JSON.stringify(play.header?.[k]) !== JSON.stringify(canonical[k]))) throw Error('Hardware header differs from paid session');
 } else {
  play.header = canonical;
  play.footer.trace_root = [...Buffer.from(traceRoot(header.sessionId, play.events).slice(2), 'hex')];
 }
 const root = traceRoot(header.sessionId, play.events);
 if (play.footer.event_count !== play.events.length || toHex(Uint8Array.from(play.footer.trace_root)) !== root) throw Error('Gameplay trace seal mismatch');
 const digest = sessionDigest(header, play.events.length, play.footer.duration_us, root);
 const result = await scoringRequest({url,token,signal}, '/v1/prove', {mode:'calldata',input:play}, 600000);
 if (!result || result.mode !== 'Calldata' || result.sessionDigest !== digest) throw Error('Scoring proof does not match captured session');
 checkSrs(result.srsId, expectedSrsId);
 const uints = (values, length) => Array.isArray(values) && values.length === length && values.every(n => Number.isSafeInteger(n) && n >= 0);
 if (!uints(result.laneBits, 4) || !uints(result.counts, 5) || !Array.isArray(result.proof) || !result.proof.length || !result.proof.every(word)) throw Error('Invalid scoring proof response');
 return {sub:{duration:BigInt(play.footer.duration_us),laneBits:result.laneBits,counts:result.counts},digest,n:play.events.length,root,proof:result.proof.map(w => BigInt(w)),events:eventBytes(play.events)};
}
export async function validateSeal(header,input,signature){
 const canonical=rustHeader(header);if(Object.keys(canonical).some(k=>JSON.stringify(input.header?.[k])!==JSON.stringify(canonical[k])))throw Error('Hardware header differs from paid session');
 if(input.footer.event_count!==input.events.length)throw Error('Hardware event count mismatch');
 const root=traceRoot(header.sessionId,input.events);
 if(toHex(Uint8Array.from(input.footer.trace_root))!==root)throw Error('Hardware trace root mismatch');
 const digest=sessionDigest(header,input.events.length,input.footer.duration_us,root);
 if((await recoverAddress({hash:digest,signature})).toLowerCase()!==header.device.toLowerCase())throw Error('Hardware signature mismatch');return digest;
}
