#ifndef OPTEE_SIGNER_H
#define OPTEE_SIGNER_H

#include "osumania_protocol.h"

#include <stdbool.h>
#include <stdint.h>

struct osum_signer;

struct osum_signer_info {
    uint8_t device[20];
    uint8_t bitstream_hash[32];
};

struct osum_signer *osum_signer_open(const char *backend);
void osum_signer_close(struct osum_signer *signer);
bool osum_signer_ready(const struct osum_signer *signer);
bool osum_signer_is_insecure(const struct osum_signer *signer);
enum osum_state osum_signer_state(const struct osum_signer *signer);
void osum_signer_failure(const struct osum_signer *signer, uint32_t *result,
                         uint32_t *origin);
int osum_signer_get_info(struct osum_signer *signer, struct osum_signer_info *info);
int osum_signer_set_header(struct osum_signer *signer, const uint8_t header[OSUM_HEADER_SIZE],
                           uint8_t *detail);
int osum_signer_start(struct osum_signer *signer);
int osum_signer_finalize(struct osum_signer *signer, uint32_t count, uint64_t duration_us,
                         const uint8_t trace_root[32], const uint8_t commitment[64]);
int osum_signer_get_result(struct osum_signer *signer, uint8_t result[OSUM_RESULT_SIZE]);
int osum_signer_abort(struct osum_signer *signer);

#endif
