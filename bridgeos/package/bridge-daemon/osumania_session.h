#ifndef OSUMANIA_SESSION_H
#define OSUMANIA_SESSION_H

#include "optee_signer.h"
#include "osumania_crypto.h"
#include "osumania_protocol.h"

#include <stdbool.h>
#include <stdint.h>

struct osum_session;

struct osum_session_info {
    uint8_t device[20];
    uint8_t bitstream_hash[32];
    uint8_t input_policy_hash[32];
    uint8_t srs_hash[32];
    uint32_t max_events;
};

struct osum_session_status {
    enum osum_state state;
    enum osum_error last_error;
    uint32_t event_count;
    uint64_t elapsed_us;
};

struct osum_session *osum_session_create(const char *srs_path, const char *signer_backend);
void osum_session_destroy(struct osum_session *session);
int osum_session_info(struct osum_session *session, struct osum_session_info *info,
                      uint8_t *detail, uint32_t *tee_result, uint32_t *tee_origin);
void osum_session_status(struct osum_session *session, struct osum_session_status *status);
int osum_session_set_header(struct osum_session *session,
                            const uint8_t header[OSUM_HEADER_SIZE], uint8_t *detail);
int osum_session_start(struct osum_session *session);
int osum_session_stop(struct osum_session *session);
int osum_session_abort(struct osum_session *session);
int osum_session_result(struct osum_session *session, uint8_t result[OSUM_RESULT_SIZE]);
uint32_t osum_session_trace_length(struct osum_session *session);
int osum_session_trace_read(void *context, uint32_t offset, uint8_t *destination, size_t length);

/* Producer-only hot-path API. It never waits for crypto or OP-TEE. */
void osum_session_capture_edge(struct osum_session *session, uint8_t lane, uint8_t action);
/* Fail an active signed capture when physical input or the live sideband is lost. */
void osum_session_input_lost(struct osum_session *session, enum osum_error error);

#endif
