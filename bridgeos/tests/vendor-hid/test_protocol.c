#define _GNU_SOURCE
#include "osumania_crypto.h"
#include "osumania_protocol.h"
#include "optee_signer.h"
#include "osumania_session.h"
#include "vector_cases.h"

#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/obj_mac.h>
#include <openssl/sha.h>

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void packet(uint8_t out[64], uint8_t type, uint32_t id, uint32_t offset,
                   uint32_t total, const uint8_t *data, size_t length)
{
    memset(out, 0, 64); out[0] = OSUM_MAGIC; out[1] = OSUM_VERSION; out[2] = type;
    osum_be32_store(out + 4, id); osum_be32_store(out + 8, offset); osum_be32_store(out + 12, total);
    if (length) memcpy(out + 16, data, length);
}

struct pattern { uint32_t length; };
static int pattern_read(void *context, uint32_t offset, uint8_t *dst, size_t length)
{
    struct pattern *pattern = context;
    if (offset > pattern->length || length > pattern->length - offset) return -1;
    for (size_t i = 0; i < length; ++i) dst[i] = (uint8_t)((offset + i) * 17u + 3u);
    return 0;
}

static void test_framing(void)
{
    struct osum_rx rx = {0}; struct osum_request request; uint8_t report[64];
    packet(report, OSUM_GET_INFO, 1, 0, 0, NULL, 0);
    assert(osum_rx_report(&rx, report, &request) == OSUM_OK && request.transfer_id == 1);
    report[1] = 2; assert(osum_rx_report(&rx, report, &request) == OSUM_BAD_PROTOCOL_VERSION);

    uint8_t header[292]; for (unsigned i = 0; i < sizeof(header); ++i) header[i] = (uint8_t)i;
    for (uint32_t off = 0; off < sizeof(header); off += 48) {
        size_t n = sizeof(header) - off < 48 ? sizeof(header) - off : 48;
        packet(report, OSUM_SET_HEADER, 2, off, sizeof(header), header + off, n);
        assert(osum_rx_report(&rx, report, &request) == OSUM_OK);
    }
    assert(request.length == sizeof(header) && !memcmp(request.payload, header, sizeof(header)));

    packet(report, OSUM_SET_HEADER, 3, 0, 292, header, 48);
    assert(osum_rx_report(&rx, report, &request) == OSUM_OK);
    assert(osum_rx_report(&rx, report, &request) == OSUM_BAD_FRAGMENT_OFFSET); /* duplicate */
    packet(report, OSUM_SET_HEADER, 4, 48, 292, header + 48, 48);
    assert(osum_rx_report(&rx, report, &request) == OSUM_BAD_FRAGMENT_OFFSET); /* skipped first */
    packet(report, OSUM_SET_HEADER, 8, 0, 292, header, 48);
    assert(osum_rx_report(&rx, report, &request) == OSUM_OK);
    packet(report, OSUM_SET_HEADER, 9, 48, 292, header + 48, 48);
    assert(osum_rx_report(&rx, report, &request) == OSUM_BAD_FRAGMENT_OFFSET); /* changed id */
    packet(report, OSUM_SET_HEADER, 10, 0, 292, header, 48);
    assert(osum_rx_report(&rx, report, &request) == OSUM_OK);
    packet(report, OSUM_SET_HEADER, 10, 48, 244, header + 48, 48);
    assert(osum_rx_report(&rx, report, &request) == OSUM_BAD_LENGTH); /* changed total */
    packet(report, OSUM_GET_TRACE, 11, 0, OSUM_MAX_LOGICAL_SIZE + 1u, NULL, 0);
    assert(osum_rx_report(&rx, report, &request) == OSUM_BAD_LENGTH);
    packet(report, OSUM_SET_HEADER, 5, 0, 352, header, 48);
    assert(osum_rx_report(&rx, report, &request) == OSUM_BAD_LENGTH); /* ABI header */
    packet(report, OSUM_SET_HEADER, 6, 288, 292, header + 288, 4); report[20] = 1;
    assert(osum_rx_report(&rx, report, &request) == OSUM_BAD_LENGTH); /* nonzero padding */

    struct pattern source = { OSUM_MAX_LOGICAL_SIZE }; struct osum_tx tx;
    osum_tx_begin(&tx, OSUM_GET_TRACE, OSUM_FLAG_RESPONSE, 7, source.length, pattern_read, &source);
    uint32_t offset = 0, reports = 0; int next;
    while ((next = osum_tx_next(&tx, report)) > 0) {
        assert(osum_be32_load(report + 8) == offset);
        size_t n = source.length - offset < 48 ? source.length - offset : 48;
        for (size_t i = 0; i < n; ++i) assert(report[16+i] == (uint8_t)((offset+i)*17u+3u));
        offset += n; ++reports;
    }
    assert(next == 0 && offset == source.length && reports == 14584);
}

static void test_live_events(void)
{
    struct osum_live_queue queue;
    struct osum_live_edge edge;
    uint8_t report[OSUM_REPORT_SIZE];
    osum_live_queue_init(&queue);
    assert(!osum_live_dequeue(&queue, &edge));
    for (unsigned i = 0; i < OSUM_LIVE_QUEUE_SIZE; ++i)
        assert(osum_live_enqueue(&queue, 0x0102030405060708ULL + i,
                                 (uint8_t)(i & 3), (uint8_t)(i & 1)));
    assert(!osum_live_enqueue(&queue, 99, 2, 0)); /* bounded overflow consumes seq */
    assert(osum_live_dequeue(&queue, &edge));
    assert(edge.sequence == 0 && edge.timestamp_us == 0x0102030405060708ULL);
    assert(osum_live_enqueue(&queue, 0x1122334455667788ULL, 3, 1));
    for (unsigned i = 1; i < OSUM_LIVE_QUEUE_SIZE; ++i) {
        assert(osum_live_dequeue(&queue, &edge));
        assert(edge.sequence == i && edge.timestamp_us == 0x0102030405060708ULL + i);
    }
    assert(osum_live_dequeue(&queue, &edge));
    assert(edge.sequence == OSUM_LIVE_QUEUE_SIZE + 1 &&
           edge.timestamp_us == 0x1122334455667788ULL && edge.lane == 3 && edge.action == 1);
    assert(!osum_live_dequeue(&queue, &edge));

    memset(report, 0xff, sizeof(report));
    osum_live_report(&edge, report);
    const uint8_t expected_header[16] = {
        OSUM_MAGIC, OSUM_VERSION, OSUM_LIVE_EDGE, OSUM_FLAG_LIVE,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, OSUM_EVENT_SIZE
    };
    assert(!memcmp(report, expected_header, sizeof(expected_header)));
    assert(osum_be32_load(report + 16) == OSUM_LIVE_QUEUE_SIZE + 1);
    assert(osum_be64_load(report + 20) == 0x1122334455667788ULL);
    assert(report[28] == 3 && report[29] == 1);
    for (size_t i = 30; i < sizeof(report); ++i) assert(report[i] == 0);

    assert(osum_live_enqueue(&queue, 1, 0, 0));
    osum_live_discard(&queue); /* transport disconnect must not replay stale edges */
    assert(!osum_live_dequeue(&queue, &edge));
    assert(osum_live_enqueue(&queue, 2, 0, 1));
    assert(osum_live_dequeue(&queue, &edge) && edge.sequence == OSUM_LIVE_QUEUE_SIZE + 3);
}

static void test_vectors(void)
{
    struct osum_crypto *crypto = osum_crypto_create("tests/vendor-hid/vectors/srs-g1-be.bin");
    assert(crypto && osum_crypto_max_events(crypto) == 65);
    for (size_t c = 0; c < vector_case_count; ++c) {
        const struct vector_case *vector = &vector_cases[c];
        assert(osum_crypto_reset(crypto, vector->session_id) == 0);
        for (unsigned i = 0; i < vector->count; ++i) {
            const uint8_t *wire = vector->events + i * OSUM_EVENT_SIZE;
            struct osum_event event;
            assert(osum_event_encode(&event, osum_be32_load(wire), osum_be64_load(wire + 4), wire[12], wire[13]) == 0);
            assert(!memcmp(event.wire, wire, OSUM_EVENT_SIZE));
            assert(osum_crypto_add(crypto, &event) == 0);
        }
        uint8_t root[32], commitment[64];
        assert(osum_crypto_finalize(crypto, root, commitment) == 0);
        assert(!memcmp(root, vector->root, 32));
        assert(!memcmp(commitment, vector->commitment, 64));
        assert(osum_crypto_trace_length(crypto) == vector->event_length);
    }
    osum_crypto_destroy(crypto);
}

static void test_dev_signer(void)
{
    setenv("DEV_INSECURE_PRIVATE_KEY", "0000000000000000000000000000000000000000000000000000000000000001", 1);
    setenv("OSUMANIA_BITSTREAM_HASH", "0404040404040404040404040404040404040404040404040404040404040404", 1);
    struct osum_signer *signer = osum_signer_open("dev-insecure");
    assert(signer && osum_signer_ready(signer) && osum_signer_is_insecure(signer));
    struct osum_signer_info info; assert(osum_signer_get_info(signer, &info) == 0);
    const uint8_t expected_address[20] = {0x7e,0x5f,0x45,0x52,0x09,0x1a,0x69,0x12,0x5d,0x5d,0xfc,0xb7,0xb8,0xc2,0x65,0x90,0x29,0x39,0x5b,0xdf};
    assert(!memcmp(info.device, expected_address, 20));
    uint8_t header[292] = {0}; memcpy(header + 144, info.device, 20); memcpy(header + 228, info.bitstream_hash, 32);
    const uint8_t policy[32] = {0x1d,0xd3,0xe7,0x15,0x32,0x31,0x9b,0xcc,0xa3,0x1f,0x8f,0x24,0x8b,0xae,0x6a,0x8c,0x8e,0x05,0x7c,0xdd,0xbd,0x69,0x2b,0xfa,0xdf,0x3e,0xb0,0x6e,0x0a,0xe7,0x54,0x60};
    memcpy(header + 260, policy, 32); uint8_t detail;
    assert(osum_signer_set_header(signer, header, &detail) == 0 && osum_signer_start(signer) == 0);
    uint8_t root[32] = {1}, point[64] = {0};
    assert(osum_signer_finalize(signer, 0, 42, root, point) == 0);
    uint8_t result1[465], result2[465]; assert(osum_signer_get_result(signer, result1) == 0);
    assert(osum_signer_get_result(signer, result2) == 0 && !memcmp(result1, result2, 465));
    assert(!memcmp(result1, header, 292) && osum_be32_load(result1 + 292) == 0 && osum_be64_load(result1 + 296) == 42);
    assert(result1[464] == 27 || result1[464] == 28);
    BIGNUM *s = BN_bin2bn(result1 + 432, 32, NULL), *order = NULL, *half = BN_new();
    EC_GROUP *group = EC_GROUP_new_by_curve_name(NID_secp256k1); BN_CTX *ctx = BN_CTX_new();
    BN_hex2bn(&order, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"); BN_rshift1(half, order);
    assert(BN_cmp(s, half) <= 0);
    uint8_t preimage[430], digest[32]; memcpy(preimage, "OSUMANIA_HARDWARE_SESSION_V2", 28); preimage[28]=0; preimage[29]=2;
    memcpy(preimage+30,header,292); memcpy(preimage+322,result1+292,108); SHA256(preimage,430,digest);
    EC_KEY *key=EC_KEY_new_by_curve_name(NID_secp256k1); BIGNUM *one=BN_new(); BN_one(one); EC_POINT *pub=EC_POINT_new(group);
    EC_POINT_mul(group,pub,one,NULL,NULL,ctx); EC_KEY_set_public_key(key,pub);
    ECDSA_SIG *sig=ECDSA_SIG_new(); ECDSA_SIG_set0(sig,BN_bin2bn(result1+400,32,NULL),BN_bin2bn(result1+432,32,NULL));
    assert(ECDSA_do_verify(digest,32,sig,key)==1);
    ECDSA_SIG_free(sig); EC_POINT_free(pub); EC_KEY_free(key); BN_free(one); BN_free(s); BN_free(order); BN_free(half); BN_CTX_free(ctx); EC_GROUP_free(group);
    assert(osum_signer_abort(signer)==0 && osum_signer_state(signer)==OSUM_STATE_IDLE);
    osum_signer_close(signer);
}

static void make_header(uint8_t header[292], const struct osum_signer_info *info)
{
    static const uint8_t policy[32] = {0x1d,0xd3,0xe7,0x15,0x32,0x31,0x9b,0xcc,0xa3,0x1f,0x8f,0x24,0x8b,0xae,0x6a,0x8c,0x8e,0x05,0x7c,0xdd,0xbd,0x69,0x2b,0xfa,0xdf,0x3e,0xb0,0x6e,0x0a,0xe7,0x54,0x60};
    memset(header, 0, 292);
    memcpy(header + 60, "0123456789abcdef0123456789abcdef", 32);
    memcpy(header + 144, info->device, 20);
    memcpy(header + 228, info->bitstream_hash, 32);
    memcpy(header + 260, policy, 32);
}

static void test_session_states(void)
{
    struct osum_signer *signer = osum_signer_open("dev-insecure");
    struct osum_signer_info signer_info;
    assert(signer && osum_signer_get_info(signer, &signer_info) == 0);
    osum_signer_close(signer);
    struct osum_session *session = osum_session_create("tests/vendor-hid/vectors/srs-g1-be.bin", "dev-insecure");
    assert(session);
    struct osum_session_info info;
    uint8_t info_detail;
    uint32_t tee_result, tee_origin;
    assert(osum_session_info(session, &info, &info_detail, &tee_result, &tee_origin) == 0 &&
           info.max_events == 65);
    uint8_t header[292], detail;
    make_header(header, &signer_info);
    assert(osum_session_abort(session) == 0); /* IDLE */
    assert(osum_session_set_header(session, header, &detail) == 0);
    assert(osum_session_abort(session) == 0); /* HEADER_LOADED */
    assert(osum_session_set_header(session, header, &detail) == 0);
    assert(osum_session_start(session) == 0);
    assert(osum_session_abort(session) == 0); /* RECORDING */
    uint8_t bad[292]; memcpy(bad, header, 292); bad[260] ^= 1;
    assert(osum_session_set_header(session, bad, &detail) != 0 && detail == OSUM_HEADER_POLICY);
    assert(osum_session_set_header(session, header, &detail) == 0);
    assert(osum_session_start(session) == 0);
    osum_session_capture_edge(session, 0, 0);
    osum_session_input_lost(session, OSUM_INVALID_EVENT);
    struct osum_session_status lost; osum_session_status(session, &lost);
    assert(lost.state == OSUM_STATE_ERROR && lost.last_error == OSUM_INVALID_EVENT);
    assert(osum_session_stop(session) != 0); /* omitted evdev edges can never be signed */
    assert(osum_session_abort(session) == 0);
    assert(osum_session_set_header(session, header, &detail) == 0);
    assert(osum_session_start(session) == 0);
    osum_session_input_lost(session, OSUM_EVENT_OVERFLOW);
    osum_session_status(session, &lost);
    assert(lost.state == OSUM_STATE_ERROR && lost.last_error == OSUM_EVENT_OVERFLOW);
    assert(osum_session_abort(session) == 0);
    assert(osum_session_set_header(session, header, &detail) == 0);
    assert(osum_session_start(session) == 0);
    osum_session_capture_edge(session, 0, 0);
    struct osum_session_status status; osum_session_status(session, &status);
    assert(status.state == OSUM_STATE_ERROR && status.last_error == OSUM_INVALID_EVENT);
    assert(osum_session_abort(session) == 0);
    assert(osum_session_set_header(session, header, &detail) == 0);
    assert(osum_session_start(session) == 0);
    for (unsigned i = 0; i < 66; ++i)
        osum_session_capture_edge(session, 0, (uint8_t)(i & 1u));
    osum_session_status(session, &status);
    assert(status.state == OSUM_STATE_ERROR && status.last_error == OSUM_EVENT_OVERFLOW);
    assert(osum_session_abort(session) == 0);

    assert(osum_session_set_header(session, header, &detail) == 0);
    assert(osum_session_start(session) == 0);
    osum_session_capture_edge(session, 0, 0);
    osum_session_capture_edge(session, 0, 1);
    assert(osum_session_stop(session) == 0);
    uint8_t result1[465], result2[465], trace1[28], trace2[28];
    assert(osum_session_result(session, result1) == 0);
    assert(osum_session_result(session, result2) == 0 && !memcmp(result1, result2, sizeof(result1)));
    assert(osum_session_trace_length(session) == sizeof(trace1));
    assert(osum_session_trace_read(session, 0, trace1, sizeof(trace1)) == 0);
    assert(osum_session_trace_read(session, 0, trace2, sizeof(trace2)) == 0);
    assert(!memcmp(trace1, trace2, sizeof(trace1)));
    assert(osum_session_abort(session) == 0);
    osum_session_destroy(session);
}

int main(void)
{
    test_framing(); test_live_events(); test_vectors(); test_dev_signer(); test_session_states();
    puts("PASS framing, live sideband queue, session states, SHA/BN254 vectors, immutable low-s result");
    return 0;
}
