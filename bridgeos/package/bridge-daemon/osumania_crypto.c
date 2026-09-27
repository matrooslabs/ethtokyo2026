#include "osumania_crypto.h"

#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/sha.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SHA_CHUNK_EVENTS 32u
#define SHA_CHUNK_BYTES (SHA_CHUNK_EVENTS * OSUM_EVENT_SIZE)

struct osum_crypto {
    EC_GROUP *group;
    BN_CTX *bn_ctx;
    EC_POINT *accumulator;
    EC_POINT *point;
    EC_POINT *scaled;
    BIGNUM *scalar;
    BIGNUM *field;
    BIGNUM *field_half;
    uint8_t *srs;
    size_t srs_size;
    uint32_t point_count;
    uint32_t max_events;
    uint8_t srs_hash[32];
    uint8_t *trace;
    uint32_t trace_length;
    uint32_t event_count;
    uint8_t chain[32];
    uint8_t chunk[SHA_CHUNK_BYTES];
    uint16_t chunk_count;
    uint32_t chunk_index;
    bool ready;
    bool finalized;
};

static int read_file(const char *path, uint8_t **output, size_t *length)
{
    FILE *file = fopen(path, "rb");
    if (!file)
        return -1;
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return -1;
    }
    long size = ftell(file);
    if (size <= 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return -1;
    }
    uint8_t *data = malloc((size_t)size);
    if (!data || fread(data, 1, (size_t)size, file) != (size_t)size) {
        free(data);
        fclose(file);
        return -1;
    }
    fclose(file);
    *output = data;
    *length = (size_t)size;
    return 0;
}

static EC_GROUP *bls12381_group(void)
{
    BIGNUM *p = NULL, *a = BN_new(), *b = BN_new();
    BN_hex2bn(&p, "1A0111EA397FE69A4B1BA7B6434BACD764774B84F38512BF6730D2A0F6B0F6241EABFFFEB153FFFFB9FEFFFFFFFFAAAB");
    if (!p || !a || !b || !BN_set_word(a, 0) || !BN_set_word(b, 4)) {
        BN_free(p); BN_free(a); BN_free(b);
        return NULL;
    }
    EC_GROUP *group = EC_GROUP_new_curve_GFp(p, a, b, NULL);
    BN_free(p); BN_free(a); BN_free(b);
    return group;
}

/* IETF BLS12-381 G1 compressed encoding: x in big endian, C/I/S flag bits. */
static int point_from_bank(const struct osum_crypto *crypto, uint32_t index, EC_POINT *point)
{
    if (index >= crypto->point_count)
        return -1;
    const uint8_t *encoded = crypto->srs + (size_t)index * 48u;
    if ((encoded[0] & 0xc0u) != 0x80u)
        return -1; /* No infinity in an SRS and compression is mandatory. */
    uint8_t x_bytes[48];
    memcpy(x_bytes, encoded, sizeof(x_bytes));
    x_bytes[0] &= 0x1fu;
    BN_CTX_start(crypto->bn_ctx);
    BIGNUM *x = BN_CTX_get(crypto->bn_ctx);
    BIGNUM *y = BN_CTX_get(crypto->bn_ctx);
    int ok = x && y &&
             BN_bin2bn(x_bytes, sizeof(x_bytes), x) &&
             BN_cmp(x, crypto->field) < 0 &&
             EC_POINT_set_compressed_coordinates(crypto->group, point, x, 0, crypto->bn_ctx) == 1 &&
             EC_POINT_get_affine_coordinates(crypto->group, point, NULL, y, crypto->bn_ctx) == 1;
    if (ok && ((BN_cmp(y, crypto->field_half) > 0) != !!(encoded[0] & 0x20u)))
        ok = EC_POINT_invert(crypto->group, point, crypto->bn_ctx) == 1;
    BN_CTX_end(crypto->bn_ctx);
    return ok ? 0 : -1;
}

struct osum_crypto *osum_crypto_create(const char *srs_path)
{
    struct osum_crypto *crypto = calloc(1, sizeof(*crypto));
    if (!crypto)
        return NULL;
    crypto->group = bls12381_group();
    crypto->bn_ctx = BN_CTX_new();
    crypto->accumulator = crypto->group ? EC_POINT_new(crypto->group) : NULL;
    crypto->point = crypto->group ? EC_POINT_new(crypto->group) : NULL;
    crypto->scaled = crypto->group ? EC_POINT_new(crypto->group) : NULL;
    crypto->scalar = BN_new();
    crypto->field = BN_new();
    crypto->field_half = BN_new();
    if (!crypto->group || !crypto->bn_ctx || !crypto->accumulator || !crypto->point ||
        !crypto->scaled || !crypto->scalar || !crypto->field || !crypto->field_half ||
        EC_GROUP_get_curve(crypto->group, crypto->field, NULL, NULL, crypto->bn_ctx) != 1 ||
        !BN_rshift1(crypto->field_half, crypto->field) || !srs_path ||
        read_file(srs_path, &crypto->srs, &crypto->srs_size) != 0 ||
        crypto->srs_size % (4u * 48u) != 0 ||
        crypto->srs_size > OSUM_MAX_EVENTS * 4u * 48u) {
        osum_crypto_destroy(crypto);
        return NULL;
    }
    crypto->point_count = (uint32_t)(crypto->srs_size / 48u);
    crypto->max_events = crypto->point_count / 4u;
    if (crypto->max_events == 0 || crypto->max_events > OSUM_MAX_EVENTS) {
        osum_crypto_destroy(crypto);
        return NULL;
    }
    SHA256(crypto->srs, crypto->srs_size, crypto->srs_hash);
    crypto->trace = calloc(crypto->max_events, OSUM_EVENT_SIZE);
    if (!crypto->trace) {
        osum_crypto_destroy(crypto);
        return NULL;
    }
    static const uint8_t generator[48] = {
        0x97,0xf1,0xd3,0xa7,0x31,0x97,0xd7,0x94,0x26,0x95,0x63,0x8c,
        0x4f,0xa9,0xac,0x0f,0xc3,0x68,0x8c,0x4f,0x97,0x74,0xb9,0x05,
        0xa1,0x4e,0x3a,0x3f,0x17,0x1b,0xac,0x58,0x6c,0x55,0xe8,0x3f,
        0xf9,0x7a,0x1a,0xef,0xfb,0x3a,0xf0,0x0a,0xdb,0x22,0xc6,0xbb,
    };
    if (memcmp(crypto->srs, generator, sizeof(generator)) != 0) {
        osum_crypto_destroy(crypto);
        return NULL;
    }
    /* SHA-256 binds the entire bank to the TA and prover. Decode points only
     * as events arrive; an invalid used point aborts before signing. Validating
     * 200,000 points up front delays Vendor HID readiness past host timeouts. */
    crypto->ready = true;
    return crypto;
}

void osum_crypto_destroy(struct osum_crypto *crypto)
{
    if (!crypto)
        return;
    if (crypto->trace) {
        OPENSSL_cleanse(crypto->trace, (size_t)crypto->max_events * OSUM_EVENT_SIZE);
        free(crypto->trace);
    }
    free(crypto->srs);
    EC_POINT_free(crypto->accumulator);
    EC_POINT_free(crypto->point);
    EC_POINT_free(crypto->scaled);
    BN_clear_free(crypto->scalar);
    BN_free(crypto->field);
    BN_free(crypto->field_half);
    EC_GROUP_free(crypto->group);
    BN_CTX_free(crypto->bn_ctx);
    OPENSSL_cleanse(crypto, sizeof(*crypto));
    free(crypto);
}

bool osum_crypto_ready(const struct osum_crypto *crypto)
{
    return crypto && crypto->ready;
}

uint32_t osum_crypto_max_events(const struct osum_crypto *crypto)
{
    return crypto ? crypto->max_events : 0;
}

const uint8_t *osum_crypto_srs_hash(const struct osum_crypto *crypto)
{
    return crypto ? crypto->srs_hash : NULL;
}

int osum_crypto_reset(struct osum_crypto *crypto, const uint8_t session_id[32])
{
    static const uint8_t domain[] = "OSUMANIA_TRACE_V1";
    if (!osum_crypto_ready(crypto))
        return -1;
    uint8_t seed[sizeof(domain) - 1u + 32u];
    memcpy(seed, domain, sizeof(domain) - 1u);
    memcpy(seed + sizeof(domain) - 1u, session_id, 32u);
    SHA256(seed, sizeof(seed), crypto->chain);
    OPENSSL_cleanse(seed, sizeof(seed));
    memset(crypto->trace, 0, (size_t)crypto->max_events * OSUM_EVENT_SIZE);
    memset(crypto->chunk, 0, sizeof(crypto->chunk));
    crypto->trace_length = 0;
    crypto->event_count = 0;
    crypto->chunk_count = 0;
    crypto->chunk_index = 0;
    crypto->finalized = false;
    return EC_POINT_set_to_infinity(crypto->group, crypto->accumulator) == 1 ? 0 : -1;
}

int osum_event_encode(struct osum_event *event, uint32_t sequence, uint64_t timestamp_us,
                      uint8_t lane, uint8_t action)
{
    if (!event || lane > 3 || action > 1)
        return -1;
    event->sequence = sequence;
    event->timestamp_us = timestamp_us;
    event->lane = lane;
    event->action = action;
    osum_be32_store(event->wire, sequence);
    osum_be64_store(event->wire + 4, timestamp_us);
    event->wire[12] = lane;
    event->wire[13] = action;
    return 0;
}

static int add_scaled_point(struct osum_crypto *crypto, uint32_t point_index,
                            const uint8_t *scalar_bytes, size_t scalar_length)
{
    if (!BN_bin2bn(scalar_bytes, (int)scalar_length, crypto->scalar))
        return -1;
    if (BN_is_zero(crypto->scalar))
        return 0;
    return point_from_bank(crypto, point_index, crypto->point) == 0 &&
           EC_POINT_mul(crypto->group, crypto->scaled, NULL, crypto->point,
                        crypto->scalar, crypto->bn_ctx) == 1 &&
           EC_POINT_add(crypto->group, crypto->accumulator, crypto->accumulator,
                        crypto->scaled, crypto->bn_ctx) == 1 ? 0 : -1;
}

static int flush_chunk(struct osum_crypto *crypto)
{
    if (crypto->chunk_count == 0)
        return 0;
    const size_t bytes = (size_t)crypto->chunk_count * OSUM_EVENT_SIZE;
    uint8_t preimage[32u + 4u + 2u + SHA_CHUNK_BYTES];
    memcpy(preimage, crypto->chain, 32u);
    osum_be32_store(preimage + 32u, crypto->chunk_index);
    osum_be16_store(preimage + 36u, crypto->chunk_count);
    memcpy(preimage + 38u, crypto->chunk, bytes);
    SHA256(preimage, 38u + bytes, crypto->chain);
    OPENSSL_cleanse(preimage, sizeof(preimage));
    memset(crypto->chunk, 0, sizeof(crypto->chunk));
    crypto->chunk_count = 0;
    ++crypto->chunk_index;
    return 0;
}

int osum_crypto_add(struct osum_crypto *crypto, const struct osum_event *event)
{
    if (!osum_crypto_ready(crypto) || !event || crypto->finalized ||
        event->sequence != crypto->event_count || crypto->event_count >= crypto->max_events)
        return -1;
    if (crypto->event_count && event->timestamp_us <
        osum_be64_load(crypto->trace + crypto->trace_length - OSUM_EVENT_SIZE + 4))
        return -1;

    memcpy(crypto->trace + crypto->trace_length, event->wire, OSUM_EVENT_SIZE);
    crypto->trace_length += OSUM_EVENT_SIZE;
    memcpy(crypto->chunk + (size_t)crypto->chunk_count * OSUM_EVENT_SIZE,
           event->wire, OSUM_EVENT_SIZE);

    const uint32_t base = event->sequence * 4u;
    if (add_scaled_point(crypto, base, event->wire + 4, 8) != 0 ||
        add_scaled_point(crypto, base + 1u, event->wire + 12, 1) != 0 ||
        add_scaled_point(crypto, base + 2u, event->wire + 13, 1) != 0)
        return -1;
    ++crypto->event_count;
    ++crypto->chunk_count;
    return crypto->chunk_count == SHA_CHUNK_EVENTS ? flush_chunk(crypto) : 0;
}

int osum_crypto_finalize(struct osum_crypto *crypto, uint8_t trace_root[32],
                         uint8_t commitment[48])
{
    if (!osum_crypto_ready(crypto) || crypto->finalized || flush_chunk(crypto) != 0)
        return -1;
    memcpy(trace_root, crypto->chain, 32u);
    memset(commitment, 0, 48u);
    if (EC_POINT_is_at_infinity(crypto->group, crypto->accumulator)) {
        commitment[0] = 0xc0u;
    } else {
        BN_CTX_start(crypto->bn_ctx);
        BIGNUM *x = BN_CTX_get(crypto->bn_ctx);
        BIGNUM *y = BN_CTX_get(crypto->bn_ctx);
        int ok = x && y &&
                 EC_POINT_get_affine_coordinates(crypto->group, crypto->accumulator,
                                                 x, y, crypto->bn_ctx) == 1 &&
                 BN_bn2binpad(x, commitment, 48) == 48;
        if (ok)
            commitment[0] |= (uint8_t)(0x80u | (BN_cmp(y, crypto->field_half) > 0 ? 0x20u : 0));
        BN_CTX_end(crypto->bn_ctx);
        if (!ok)
            return -1;
    }
    crypto->finalized = true;
    return 0;
}

uint32_t osum_crypto_event_count(const struct osum_crypto *crypto)
{
    return crypto ? crypto->event_count : 0;
}

uint32_t osum_crypto_trace_length(const struct osum_crypto *crypto)
{
    return crypto ? crypto->trace_length : 0;
}

int osum_crypto_trace_read(const struct osum_crypto *crypto, uint32_t offset,
                           uint8_t *destination, size_t length)
{
    if (!crypto || !crypto->finalized || offset > crypto->trace_length ||
        length > crypto->trace_length - offset)
        return -1;
    memcpy(destination, crypto->trace + offset, length);
    return 0;
}
