import test from 'node:test';
import assert from 'node:assert/strict';
import { GET_INFO, GET_STATUS, GET_RESULT, GET_TRACE, SET_HEADER, START, REPORT_SIZE,
  ResponseAssembler, decodeHex, encodeHex, parseInfo, parseLiveEvent, parseStatus, requestReport } from '../src/lib/hardware/protocol.ts';

function response(type, id, payload, offset = 0, flags = 1) {
  const frame = new Uint8Array(REPORT_SIZE);
  const view = new DataView(frame.buffer);
  frame.set([0x4d, 1, type, flags]);
  view.setUint32(4, id);
  view.setUint32(8, offset);
  view.setUint32(12, payload.length);
  frame.set(payload.subarray(offset, offset + 48), 16);
  return frame;
}

function infoPayload() {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1);
  view.setUint16(2, 64);
  for (let i = 8; i < 28; i++) bytes[i] = i;
  bytes.fill(0xab, 28, 60);
  bytes.fill(0xcd, 60, 92);
  bytes.fill(0xef, 92, 124);
  view.setUint32(124, 65);
  return bytes;
}

function liveEvent(seq = 0, timestampUs = 0n, lane = 0, action = 0) {
  const frame = new Uint8Array(REPORT_SIZE);
  const view = new DataView(frame.buffer);
  frame.set([0x4d, 1, 0x30, 4]);
  view.setUint32(12, 14);
  view.setUint32(16, seq);
  view.setBigUint64(20, timestampUs);
  frame[28] = lane;
  frame[29] = action;
  return frame;
}

test('live Vendor HID event accepts initial zero, maximal sequence, 64-bit timestamp and both edges', () => {
  assert.deepEqual(parseLiveEvent(liveEvent()), { seq: 0, timestampUs: 0n, lane: 0, action: 0 });
  const frame = liveEvent(0xffffffff, 0x123456789abcdef0n, 3, 1);
  const prefixed = new Uint8Array(REPORT_SIZE + 2);
  prefixed.set(frame, 1);
  assert.deepEqual(parseLiveEvent(prefixed.subarray(1, 65)), {
    seq: 0xffffffff, timestampUs: 0x123456789abcdef0n, lane: 3, action: 1,
  });
  assert.equal(parseLiveEvent(response(GET_STATUS, 9, new Uint8Array(16))), null);
  assert.equal(parseLiveEvent(new Uint8Array()), null);
});

test('matching live reports fail closed on length, magic, version, flags, IDs, offset, size and payload', () => {
  for (const mutate of [
    (frame) => frame.subarray(0, 63),
    (frame) => { frame[0] = 0; },
    (frame) => { frame[1] = 2; },
    (frame) => { frame[3] = 1; },
    (frame) => { frame[7] = 1; },
    (frame) => { frame[11] = 1; },
    (frame) => { frame[15] = 13; },
    (frame) => { frame[28] = 4; },
    (frame) => { frame[29] = 2; },
    (frame) => { frame[30] = 1; },
    (frame) => { frame[63] = 1; },
  ]) {
    const frame = liveEvent(1, 123n, 2, 1);
    assert.throws(() => parseLiveEvent(mutate(frame) || frame), /live event/);
  }
});

test('WebHID no-ID command uses exact zero-padded 64-byte big-endian frame', () => {
  const frame = requestReport(GET_INFO, 0x12345678);
  assert.equal(frame.length, 64);
  assert.deepEqual([...frame.slice(0, 16)], [0x4d, 1, 1, 0, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(frame.slice(16).every(byte => byte === 0), true);
  assert.throws(() => requestReport(GET_STATUS, 0));
});

test('ordered three-fragment GET_INFO uses signer address, hashes, max events', () => {
  const payload = infoPayload();
  const rx = new ResponseAssembler(GET_INFO, 7);
  assert.equal(rx.push(response(GET_STATUS, 7, payload)), null);
  assert.equal(rx.push(response(GET_INFO, 6, payload)), null);
  assert.equal(rx.push(response(GET_INFO, 7, payload)), null);
  assert.equal(rx.push(response(GET_INFO, 7, payload, 48)), null);
  const info = parseInfo(rx.push(response(GET_INFO, 7, payload, 96)));
  assert.equal(info.deviceAddress, '0x' + Array.from({length:20}, (_, i) => (i+8).toString(16).padStart(2,'0')).join(''));
  assert.equal(info.srsHash, 'ef'.repeat(32));
  assert.equal(info.maxEvents, 65);
  assert.equal(info.reportSize, 64);
});

test('GET_STATUS rejects malformed ordering and parses 64-bit elapsed time', () => {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  payload[0] = 2;
  view.setUint16(2, 6);
  view.setUint32(4, 10);
  view.setBigUint64(8, 0x123456789abcdef0n);
  assert.deepEqual(parseStatus(new ResponseAssembler(GET_STATUS, 42).push(response(GET_STATUS, 42, payload))), {
    state: 'recording', lastError: 6, eventCount: 10, elapsedUs: 0x123456789abcdef0n,
  });
  const outOfOrder = response(GET_INFO, 42, infoPayload(), 48);
  assert.throws(() => new ResponseAssembler(GET_INFO, 42).push(outOfOrder), /fragment order/);
  assert.throws(() => parseStatus(new Uint8Array(15)), /length|payload/);
});

test('tampered padding, flags, length and signer identity fail closed', () => {
  const status = new Uint8Array(16);
  for (const mutate of [
    (frame) => { frame[32] = 9; },
    (frame) => { frame[3] = 0; },
    (frame) => { frame[12] = 1; },
  ]) {
    const frame = response(GET_STATUS, 3, status);
    mutate(frame);
    assert.throws(() => new ResponseAssembler(GET_STATUS, 3).push(frame));
  }
  const unregistered = infoPayload();
  unregistered.fill(0, 8, 28);
  assert.throws(() => parseInfo(unregistered), /unregistered/);
  const noEvents = infoPayload();
  noEvents.fill(0, 124);
  assert.throws(() => parseInfo(noEvents), /unregistered/);
});

test('device error response preserves failure rather than reporting ready', () => {
  const payload = Uint8Array.from([0, 8, 255, 4, ...new TextEncoder().encode('SRS unavailable')]);
  assert.throws(() => new ResponseAssembler(GET_INFO, 2).push(response(GET_INFO, 2, payload, 0, 3)), /0x0008.*SRS unavailable/);
});

test('header fragments and no-payload START acknowledgment use the canonical frame', () => {
  const header = Uint8Array.from({length: 292}, (_, index) => index & 255);
  const first = requestReport(SET_HEADER, 9, header);
  const last = requestReport(SET_HEADER, 9, header, 288);
  assert.equal(new DataView(first.buffer).getUint32(12), 292);
  assert.deepEqual(first.slice(16), header.slice(0, 48));
  assert.equal(new DataView(last.buffer).getUint32(8), 288);
  assert.deepEqual(last.slice(16, 20), header.slice(288));
  assert.equal(last.slice(20).every(byte => byte === 0), true);
  assert.deepEqual(new ResponseAssembler(START, 5).push(response(START, 5, new Uint8Array())), new Uint8Array());
  const dirty = response(START, 5, new Uint8Array());
  dirty[16] = 1;
  assert.throws(() => new ResponseAssembler(START, 5).push(dirty));
  assert.deepEqual(decodeHex('0x' + encodeHex(header), 292), header);
  assert.throws(() => decodeHex('0xz1', 1));
});

test('GET_RESULT and GET_TRACE preserve original large multi-fragment bytes', () => {
  const result = Uint8Array.from({ length: 465 }, (_, index) => index & 255);
  const signed = new ResponseAssembler(GET_RESULT, 11);
  let signedBytes;
  for (let offset = 0; offset < result.length; offset += 48) {
    signedBytes = signed.push(response(GET_RESULT, 11, result, offset));
  }
  assert.deepEqual(signedBytes, result);
  const trace = Uint8Array.from({ length: 14 * 65 }, (_, index) => (index * 7) & 255);
  const streamed = new ResponseAssembler(GET_TRACE, 12);
  let bytes;
  for (let offset = 0; offset < trace.length; offset += 48) {
    bytes = streamed.push(response(GET_TRACE, 12, trace, offset));
  }
  assert.deepEqual(bytes, trace);
  const tooLarge = response(GET_TRACE, 13, new Uint8Array(48));
  new DataView(tooLarge.buffer).setUint32(12, 700001);
  assert.throws(() => new ResponseAssembler(GET_TRACE, 13).push(tooLarge));
});
