Implement osu! web’s browser-side communication with the existing
bridgeos Vendor HID device. This is an integration with an ALREADY
IMPLEMENTED board protocol, not a request to design a new USB protocol
or change board firmware.

This prompt is self-contained. Implement the web-side flow that opens
the board’s Vendor HID interface, sends session commands, and retrieves
the complete original trace and signed result. Use the web repository’s
existing finalized-session, gameplay, and result-handling architecture;
do not invent a replacement for its existing prover or contract flow.

EXISTING BOARD IMPLEMENTATION

The board exposes two HID interfaces:

- Keyboard HID: forwards physical keys to osu!. Do not open or claim it.
- Vendor HID: session commands and result/trace retrieval.

The gadget’s Vendor HID descriptor uses usage page 0xFF60, application
usage 0x01, no Report ID, and fixed 64-byte Input and Output reports.
The board daemon handles this interface through /dev/hidg1; the
keyboard uses /dev/hidg0.

In the browser use WebHID, NOT WebUSB. Select the Vendor HID collection
by usagePage=0xFF60 and usage=0x01. Verify the selected collection rather
than assuming that a matching physical USB device is the correct HID
interface. The board configuration currently contains a user-supplied
VID/PID, d86a:1000, whose assignment has not been independently
verified. Do not hard-code it as an officially assigned production
identity; use the web project’s device configuration and inspect the
actual connected device.

Send a 64-byte Uint8Array with device.sendReport(0, packet).
An inputreport must have reportId===0 and data.byteLength===64.
Do not prepend a raw-HID “no Report ID” zero byte. Check these
assumptions against the actual board and target browser: physical
enumeration/WebHID behavior has not been established by repository
tests.

BYTE ORDER AND COMMON PACKET

Offsets are zero-based and inclusive. Multibyte integers are unsigned
big-endian. All hashes, addresses, coordinates, and signatures are raw
bytes, not hex text.

Every report is exactly 64 bytes:

[0]       magic = 0x4D
[1]       protocolVersion = 0x01
[2]       messageType
[3]       flags
[4:7]     nonzero uint32 transferId, chosen by the host
[8:11]    uint32 offset within the logical payload
[12:15]   uint32 totalLength of the logical payload
[16:63]   up to 48 payload bytes; unused suffix is zero

For totalLength>0, valid offsets are 0, 48, 96, ... less than
totalLength; fragment length is min(48, totalLength-offset).
There is no terminating empty fragment. For totalLength=0, exchange
exactly one packet with offset=0 and 48 zero payload bytes.

Request flags=0x00; success response flags=0x01; error response
flags=0x03. Other bits are invalid. The device echoes request type
and transferId. Send only one outstanding logical request at a time;
do not interleave messages. Increment transferId for each new request
without wrapping it on a connection. Install the inputreport listener
before sending. Validate every incoming fragment’s magic, version,
flags, ID, type, length, offset, order, and zero padding. Do not accept
a truncated response. Maximum logical length is 700,000 bytes.

The device starts responding only after the complete valid request.
A completed HID send does not prove that a state-changing command
took effect. Do not blindly retry SET_HEADER, START, or STOP after a
lost response; reconnect and inspect GET_STATUS instead. Do not use
a short generic RPC timeout for STOP or GET_TRACE.

MESSAGE TYPES AND STATES

0x01 GET_INFO    any state       empty request -> 128 bytes
0x02 GET_STATUS  any state       empty request -> 16 bytes
0x10 SET_HEADER  IDLE            292-byte request -> empty response
0x11 START       HEADER_LOADED   empty request -> empty response
0x12 STOP        RECORDING       empty request -> empty response,
                                after finalization
0x13 ABORT       any state       empty request -> empty response
0x20 GET_RESULT  FINALIZED       empty request -> 465 bytes
0x21 GET_TRACE   FINALIZED       empty request -> 14*n bytes

States: IDLE=0, HEADER_LOADED=1, RECORDING=2, FINALIZED=3,
ERROR=255.

Normal flow:
IDLE -> SET_HEADER -> HEADER_LOADED -> START -> RECORDING
     -> STOP -> FINALIZED -> GET_RESULT / GET_TRACE -> ABORT.

ABORT is idempotent in IDLE and destroys a FINALIZED result.
GET_INFO, GET_STATUS, GET_RESULT, and GET_TRACE do not change state.

IMPORTANT CURRENT-IMPLEMENTATION RECOVERY DETAILS

The existing board daemon resets incomplete request fragments on
Vendor HID disconnect. If its session is RECORDING when it detects
the disconnect, it calls ABORT; do not promise that a disconnected
recording can resume or be recovered. Query GET_STATUS after
reconnection and handle the state actually returned.

The current session implementation moves to ERROR on an internal
START failure. Do not assume that every failed START remains
HEADER_LOADED. STOP failures after capture closes also leave ERROR.
On ERROR, show the failure and use ABORT to reset the session.

GET_INFO: EXACTLY 128 BYTES

[0:1]     protocol version uint16 = 1
[2:3]     report size uint16 = 64
[4:7]     capability flags uint32 = 0
[8:27]    device Ethereum address
[28:59]   bitstreamHash
[60:91]   inputPolicyHash
[92:123]  srsHash
[124:127] maxEvents uint32

GET_INFO may instead return NOT_READY if the SRS or signer is not
provisioned/ready. The current bundled development SRS contains
260 BN254 G1 points, so its maxEvents is 65. It is insecure
development material. Do not advertise it as a production
50,000-event setup.

srsHash is SHA256 of the exact contiguous pinned G1 bank,
P[0].x_BE32 || P[0].y_BE32 || P[1].x_BE32 || P[1].y_BE32 || ... .
It is not the prover SRS file hash or verifier srsId. Compare it
with the approved SRS mapping if that configuration exists in the
web integration. HID metadata alone is not cryptographic attestation.

GET_STATUS: EXACTLY 16 BYTES

[0]      state
[1]      reserved zero
[2:3]    last error uint16; zero if none
[4:7]    accepted event count uint32
[8:15]   START-relative elapsed microseconds uint64; zero before
         START, frozen duration D after FINALIZED

SET_HEADER: EXACTLY 292 REQUEST BYTES

Use the exact packed finalized ManiaGkrRegistry.getSession(id).header,
not abi.encode(Header), which is 352 bytes:

[0:7]     chainId uint64
[8:27]    verifier, 20-byte ManiaGkrRegistry address
[28:59]   matchId
[60:91]   sessionId
[92:123]  challenge
[124:143] player, 20 bytes
[144:163] device, 20 bytes
[164:195] chartHash
[196:227] rulesetId
[228:259] bitstreamHash
[260:291] inputPolicyHash

The policy equals
SHA256(ASCII("OSUMANIA_INPUT_POLICY_V2_KZG")).

Obtain the actual finalized header through the web project’s
existing session source. Compare the complete header with that
record and approved chain/registry/device/bitstream/policy/SRS
configuration BEFORE sending it. Do not create plausible sample
header fields to make the session appear to work.

START AND EVENT FORMAT

After a successful START response the board is recording and fixes
its timestamp origin. Begin local playback only after that response.
Physical keys are forwarded through Keyboard HID, independently
of the Vendor HID connection.

Each captured physical edge becomes one 14-byte event record:

[0:3]   global sequence uint32, starting at 0
[4:11]  START-relative timestamp_us uint64
[12]    lane 0..3
[13]    action: DOWN=0, UP=1

Timestamps must not decrease; equality is allowed. Each lane starts
UP and alternates DOWN/UP; a final unmatched DOWN is allowed.
Do not derive this trace from web keydown/keyup events.

The board’s commitment uses the session-global event index j:

C_E += timestamp_us[j]*P[4j]
       + lane[j]*P[4j+1]
       + action[j]*P[4j+2]

The fourth trace slot is always zero. A BN254 G1 identity point
is encoded as 64 zero bytes and is not automatically invalid.

SHA TRACE ROOT

H0 = SHA256(ASCII("OSUMANIA_TRACE_V1") || sessionId)

H[i+1] = SHA256(
  H[i] || uint32_BE(i) || uint16_BE(count)
       || eventRecord[0] || ... || eventRecord[count-1]
)

Each full chunk is exactly 32 events. Only the final chunk can
contain 1–31 events. If n is divisible by 32, there is no empty
final chunk. For n=0, traceRoot=H0. HID report boundaries have
no relationship to these SHA chunks.

STOP AND SIGNED RESULT

STOP closes board capture and freezes START-relative duration D,
drains already accepted events, finalizes the SHA root and BN254
point, signs, enters FINALIZED, and THEN returns success.
D must be <=1,800,000,000 microseconds; n must not exceed the
reported maxEvents or 50,000. The chart-dependent lower bound
D>=registeredChart.maxEnd+136,500 cannot be checked by the board,
because only chartHash is in the header. Check it before passing
a result into proof/submission.

The board’s V2 digest is SHA256 of exactly 430 bytes:

[0:27]    ASCII "OSUMANIA_HARDWARE_SESSION_V2"
[28:29]   00 02
[30:321]  exact original 292-byte SET_HEADER
[322:325] n uint32
[326:333] D uint64
[334:365] traceRoot
[366:397] affine C_E.x_BE32
[398:429] affine C_E.y_BE32

No EIP-191/personal_sign prefix, ABI encoding, DER signature,
second hash, or host-reconstructed replacement header.

GET_RESULT: EXACTLY 465 BYTES

[0:291]   original packed header
[292:295] n uint32
[296:303] D uint64
[304:335] traceRoot
[336:367] affine C_E.x
[368:399] affine C_E.y
[400:431] secp256k1 signature r
[432:463] signature s
[464]     recovery v

The signature is exactly r_BE32 || s_BE32 || v_u8, low-s, with
v=27 or 28. Preserve the returned original header and signature;
do not substitute locally produced signed fields.

GET_TRACE: COMPLETE ORIGINAL TRACE

An empty GET_TRACE request receives exactly 14*n bytes:
event[0] || event[1] || ... || event[n-1].

There is no embedded event count or extra trace framing.
For n=0 there is one zero-length response packet. A maximum
700,000-byte trace requires 14,584 HID reports at 48 payload
bytes per packet. Do not accept truncation. Stream or process
with bounded buffers rather than assuming all fragments must
be held as separate objects. Another GET_TRACE in FINALIZED
must return the same logical bytes until ABORT.

ERROR RESPONSES

flags=0x03; type and transferId echo the request. Logical error
payload starts:

[0:1] error code uint16
[2]   current state
[3]   detail code
[4:...] optional UTF-8 diagnostic

Codes:
0x0001 BAD_PROTOCOL_VERSION
0x0002 BAD_STATE
0x0003 BAD_LENGTH
0x0004 BAD_FRAGMENT_OFFSET
0x0005 HEADER_MISMATCH
0x0006 EVENT_OVERFLOW
0x0007 SIGN_FAILED
0x0008 NOT_READY
0x0009 INVALID_EVENT
0x000A CLOCK_FAULT
0x00FF INTERNAL_ERROR

HEADER_MISMATCH details: 1=device, 2=bitstreamHash,
3=inputPolicyHash, 4=SRS unavailable.

WEB INTEGRATION AND VERIFICATION

Implement the real flow:
select/open Vendor HID -> GET_INFO -> GET_STATUS ->
SET_HEADER -> START -> STOP -> GET_RESULT -> GET_TRACE ->
hand the original result and original trace to the web app’s
existing consumer -> ABORT when they are no longer needed.

Do not ABORT immediately after retrieval if an existing consumer
still needs to retry an immutable GET_TRACE. Make lifecycle and
error states visible through the existing UI.

Before labeling the retrieved data verified, check:
- returned header equals the finalized session header;
- trace byte length is 14*n;
- every sequence, lane/action, per-lane transition, and timestamp
  is valid and timestamp<=D;
- the 32-event SHA chain equals returned traceRoot;
- the commitment equals a recomputation using the approved same SRS;
- the exact 430-byte digest and low-s signature recover
  header.device;
- the registered chart’s duration lower bound holds.

Reuse existing web-side verification/prover libraries where present.
If an approved SRS, finalized-session source, or BN254 verifier is
not available to the web app, expose that as a real integration
dependency and do not silently mark data verified or submit it.
Do not expand this task into rewriting the prover or Solidity
submission implementation.

Test framing and retrieval with event counts
0, 1, 31, 32, 33, 64, and 65, plus malformed padding/flags/offsets,
error responses, truncated GET_TRACE, and disconnect/reconnect.
The board repository’s protocol tests and development vectors
can be used as compatibility fixtures, but do not claim that
mock tests establish real WebHID enumeration.

Report what was verified in the actual browser/device, and
separately report any unavailable real-hardware checks.
