#ifndef OSUMANIA_CRYPTO_H
#define OSUMANIA_CRYPTO_H

#include "osumania_protocol.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct osum_crypto;

struct osum_event {
    uint32_t sequence;
    uint64_t timestamp_us;
    uint8_t lane;
    uint8_t action;
    uint8_t wire[OSUM_EVENT_SIZE];
};

struct osum_crypto *osum_crypto_create(const char *srs_path);
void osum_crypto_destroy(struct osum_crypto *crypto);
bool osum_crypto_ready(const struct osum_crypto *crypto);
uint32_t osum_crypto_max_events(const struct osum_crypto *crypto);
const uint8_t *osum_crypto_srs_hash(const struct osum_crypto *crypto);
int osum_crypto_reset(struct osum_crypto *crypto, const uint8_t session_id[32]);
int osum_event_encode(struct osum_event *event, uint32_t sequence, uint64_t timestamp_us,
                      uint8_t lane, uint8_t action);
int osum_crypto_add(struct osum_crypto *crypto, const struct osum_event *event);
int osum_crypto_finalize(struct osum_crypto *crypto, uint8_t trace_root[32],
                         uint8_t commitment[64]);
uint32_t osum_crypto_event_count(const struct osum_crypto *crypto);
uint32_t osum_crypto_trace_length(const struct osum_crypto *crypto);
int osum_crypto_trace_read(const struct osum_crypto *crypto, uint32_t offset,
                           uint8_t *destination, size_t length);

#endif
