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
    EC_POINT *accumulator;
    BN_CTX *bn_ctx;
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

static EC_GROUP *bn254_group(void)
{
    BIGNUM *p = NULL, *a = NULL, *b = NULL;
    BN_hex2bn(&p, "30644E72E131A029B85045B68181585D97816A916871CA8D3C208C16D87CFD47");
    a = BN_new();
    b = BN_new();
    if (!p || !a || !b) {
        BN_free(p); BN_free(a); BN_free(b);
        return NULL;
    }
    BN_zero(a);
    if (!BN_set_word(b, 3)) {
        BN_free(p); BN_free(a); BN_free(b);
        return NULL;
    }
    EC_GROUP *group = EC_GROUP_new_curve_GFp(p, a, b, NULL);
    BN_free(p); BN_free(a); BN_free(b);
    return group;
}

static int point_from_bank(const struct osum_crypto *crypto, uint32_t index, EC_POINT *point)
{
    if (index >= crypto->point_count)
        return -1;
    const uint8_t *encoded = crypto->srs + (size_t)index * 64u;
    BIGNUM *x = BN_bin2bn(encoded, 32, NULL);
    BIGNUM *y = BN_bin2bn(encoded + 32, 32, NULL);
    if (!x || !y) {
        BN_free(x); BN_free(y);
        return -1;
    }
    int ok = EC_POINT_set_affine_coordinates(crypto->group, point, x, y,
                                              crypto->bn_ctx) == 1 &&
             EC_POINT_is_on_curve(crypto->group, point, crypto->bn_ctx) == 1;
    BN_free(x); BN_free(y);
    return ok ? 0 : -1;
}

struct osum_crypto *osum_crypto_create(const char *srs_path)
{
    struct osum_crypto *crypto = calloc(1, sizeof(*crypto));
    if (!crypto)
        return NULL;
    crypto->group = bn254_group();
    crypto->bn_ctx = BN_CTX_new();
    crypto->accumulator = crypto->group ? EC_POINT_new(crypto->group) : NULL;
    if (!crypto->group || !crypto->bn_ctx || !crypto->accumulator || !srs_path ||
        read_file(srs_path, &crypto->srs, &crypto->srs_size) != 0 ||
        crypto->srs_size % 64u != 0) {
        osum_crypto_destroy(crypto);
        return NULL;
    }
    crypto->point_count = (uint32_t)(crypto->srs_size / 64u);
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
    EC_POINT *probe = EC_POINT_new(crypto->group);
    if (!probe) {
        osum_crypto_destroy(crypto);
        return NULL;
    }
    for (uint32_t i = 0; i < crypto->point_count; ++i) {
        if (point_from_bank(crypto, i, probe) != 0) {
            EC_POINT_free(probe);
            osum_crypto_destroy(crypto);
            return NULL;
        }
    }
    EC_POINT_free(probe);
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
    BIGNUM *scalar = BN_bin2bn(scalar_bytes, (int)scalar_length, NULL);
    EC_POINT *point = EC_POINT_new(crypto->group);
    EC_POINT *scaled = EC_POINT_new(crypto->group);
    int result = -1;
    if (!scalar || !point || !scaled)
        goto out;
    if (BN_is_zero(scalar)) {
        result = 0;
        goto out;
    }
    if (point_from_bank(crypto, point_index, point) != 0 ||
        EC_POINT_mul(crypto->group, scaled, NULL, point, scalar, crypto->bn_ctx) != 1 ||
        EC_POINT_add(crypto->group, crypto->accumulator, crypto->accumulator,
                     scaled, crypto->bn_ctx) != 1)
        goto out;
    result = 0;
out:
    BN_clear_free(scalar);
    EC_POINT_free(point);
    EC_POINT_free(scaled);
    return result;
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
                         uint8_t commitment[64])
{
    if (!osum_crypto_ready(crypto) || crypto->finalized || flush_chunk(crypto) != 0)
        return -1;
    memcpy(trace_root, crypto->chain, 32u);
    memset(commitment, 0, 64u);
    if (!EC_POINT_is_at_infinity(crypto->group, crypto->accumulator)) {
        BIGNUM *x = BN_new();
        BIGNUM *y = BN_new();
        int ok = x && y && EC_POINT_get_affine_coordinates(crypto->group,
                    crypto->accumulator, x, y, crypto->bn_ctx) == 1 &&
                 BN_bn2binpad(x, commitment, 32) == 32 &&
                 BN_bn2binpad(y, commitment + 32, 32) == 32;
        BN_clear_free(x); BN_clear_free(y);
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
