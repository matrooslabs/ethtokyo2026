#define _GNU_SOURCE
#include "osumania_session.h"

#include <stdatomic.h>
#include <sched.h>
#include <pthread.h>
#include <poll.h>
#include <sys/eventfd.h>
#include <time.h>
#include <unistd.h>

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#define CAPTURE_QUEUE_SIZE 1024u
#define CAPTURE_QUEUE_MASK (CAPTURE_QUEUE_SIZE - 1u)

static const uint8_t policy_hash[32] = {
    0x1d,0xd3,0xe7,0x15,0x32,0x31,0x9b,0xcc,0xa3,0x1f,0x8f,0x24,0x8b,0xae,0x6a,0x8c,
    0x8e,0x05,0x7c,0xdd,0xbd,0x69,0x2b,0xfa,0xdf,0x3e,0xb0,0x6e,0x0a,0xe7,0x54,0x60,
};

struct osum_session {
    struct osum_crypto *crypto;
    struct osum_signer *signer;
    pthread_t worker;
    int event_fd;
    atomic_bool worker_running;
    atomic_bool accepting;
    atomic_uint producers;
    atomic_uchar state;
    atomic_uint error;
    atomic_uint head;
    atomic_uint tail;
    atomic_uint accepted;
    atomic_uint processed;
    struct osum_event queue[CAPTURE_QUEUE_SIZE];
    uint8_t header[OSUM_HEADER_SIZE];
    bool lane_down[4];
    uint64_t last_timestamp_us;
    struct timespec origin;
    uint64_t duration_us;
    uint8_t trace_root[32];
    uint8_t commitment[64];
    pthread_mutex_t command_lock;
    pthread_mutex_t drain_lock;
    pthread_cond_t drain_condition;
};

static uint64_t elapsed_us(const struct timespec *origin, const struct timespec *now)
{
    int64_t ns = (int64_t)(now->tv_sec - origin->tv_sec) * 1000000000LL +
                 now->tv_nsec - origin->tv_nsec;
    return ns < 0 ? UINT64_MAX : (uint64_t)ns / 1000u;
}

static void fail_capture(struct osum_session *session, enum osum_error error)
{
    atomic_store_explicit(&session->accepting, false, memory_order_release);
    atomic_store_explicit(&session->error, (unsigned)error, memory_order_release);
    atomic_store_explicit(&session->state, OSUM_STATE_ERROR, memory_order_release);
}

static void *crypto_worker(void *argument)
{
    struct osum_session *session = argument;
    struct pollfd descriptor = { .fd = session->event_fd, .events = POLLIN };
    while (atomic_load_explicit(&session->worker_running, memory_order_acquire)) {
        (void)poll(&descriptor, 1, 100);
        uint64_t wake;
        while (read(session->event_fd, &wake, sizeof(wake)) == sizeof(wake)) { }
        pthread_mutex_lock(&session->drain_lock);
        unsigned tail = atomic_load_explicit(&session->tail, memory_order_relaxed);
        const unsigned head = atomic_load_explicit(&session->head, memory_order_acquire);
        while (tail != head) {
            if (osum_crypto_add(session->crypto, &session->queue[tail & CAPTURE_QUEUE_MASK]) != 0) {
                fail_capture(session, OSUM_INTERNAL_ERROR);
                tail = head; /* discard unsigned work; ERROR can never be signed */
                atomic_store_explicit(&session->tail, tail, memory_order_release);
                atomic_store_explicit(&session->processed,
                                      atomic_load_explicit(&session->accepted, memory_order_acquire),
                                      memory_order_release);
                break;
            }
            ++tail;
            atomic_store_explicit(&session->tail, tail, memory_order_release);
            atomic_fetch_add_explicit(&session->processed, 1u, memory_order_release);
        }
        pthread_cond_broadcast(&session->drain_condition);
        pthread_mutex_unlock(&session->drain_lock);
    }
    return NULL;
}

struct osum_session *osum_session_create(const char *srs_path, const char *signer_backend)
{
    struct osum_session *session = calloc(1, sizeof(*session));
    if (!session)
        return NULL;
    session->event_fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    session->crypto = srs_path ? osum_crypto_create(srs_path) : NULL;
    session->signer = osum_signer_open(signer_backend);
    pthread_mutex_init(&session->command_lock, NULL);
    pthread_mutex_init(&session->drain_lock, NULL);
    pthread_cond_init(&session->drain_condition, NULL);
    atomic_init(&session->state, OSUM_STATE_IDLE);
    atomic_init(&session->error, OSUM_OK);
    atomic_init(&session->worker_running, session->crypto && session->event_fd >= 0);
    atomic_init(&session->accepting, false);
    atomic_init(&session->producers, 0);
    atomic_init(&session->head, 0);
    atomic_init(&session->tail, 0);
    atomic_init(&session->accepted, 0);
    atomic_init(&session->processed, 0);
    if (atomic_load(&session->worker_running) &&
        pthread_create(&session->worker, NULL, crypto_worker, session) != 0)
        atomic_store(&session->worker_running, false);
    return session;
}

void osum_session_destroy(struct osum_session *session)
{
    if (!session) return;
    if (atomic_exchange(&session->worker_running, false)) {
        uint64_t one = 1;
        ssize_t notified = write(session->event_fd, &one, sizeof(one));
        (void)notified;
        pthread_join(session->worker, NULL);
    }
    if (session->event_fd >= 0) close(session->event_fd);
    osum_signer_close(session->signer);
    osum_crypto_destroy(session->crypto);
    pthread_cond_destroy(&session->drain_condition);
    pthread_mutex_destroy(&session->drain_lock);
    pthread_mutex_destroy(&session->command_lock);
    memset(session, 0, sizeof(*session));
    free(session);
}

int osum_session_info(struct osum_session *session, struct osum_session_info *info,
                      uint8_t *detail, uint32_t *tee_result, uint32_t *tee_origin)
{
    if (!info || !detail || !tee_result || !tee_origin)
        return -1;
    *detail = 0;
    *tee_result = 0;
    *tee_origin = 0;
    if (!session || !osum_crypto_ready(session->crypto)) {
        *detail = OSUM_HEADER_SRS;
        return -1;
    }
    if (!osum_signer_ready(session->signer)) {
        *detail = OSUM_HEADER_DEVICE;
        osum_signer_failure(session->signer, tee_result, tee_origin);
        return -1;
    }
    struct osum_signer_info signer_info;
    if (osum_signer_get_info(session->signer, &signer_info) != 0) {
        *detail = OSUM_HEADER_DEVICE;
        osum_signer_failure(session->signer, tee_result, tee_origin);
        return -1;
    }
    memcpy(info->device, signer_info.device, 20);
    memcpy(info->bitstream_hash, signer_info.bitstream_hash, 32);
    memcpy(info->input_policy_hash, policy_hash, 32);
    memcpy(info->srs_hash, osum_crypto_srs_hash(session->crypto), 32);
    info->max_events = osum_crypto_max_events(session->crypto);
    return 0;
}

void osum_session_status(struct osum_session *session, struct osum_session_status *status)
{
    memset(status, 0, sizeof(*status));
    status->state = session ? atomic_load(&session->state) : OSUM_STATE_ERROR;
    status->last_error = session ? atomic_load(&session->error) : OSUM_INTERNAL_ERROR;
    status->event_count = session ? atomic_load(&session->accepted) : 0;
    if (!session) return;
    if (status->state == OSUM_STATE_RECORDING) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        uint64_t elapsed = elapsed_us(&session->origin, &now);
        status->elapsed_us = elapsed == UINT64_MAX ? 0 : elapsed;
    } else if (status->state == OSUM_STATE_FINALIZED || status->state == OSUM_STATE_ERROR) {
        status->elapsed_us = session->duration_us;
    }
}

int osum_session_set_header(struct osum_session *session,
                            const uint8_t header[OSUM_HEADER_SIZE], uint8_t *detail)
{
    if (!session || !osum_crypto_ready(session->crypto) || !osum_signer_ready(session->signer)) {
        *detail = OSUM_HEADER_SRS;
        return -1;
    }
    pthread_mutex_lock(&session->command_lock);
    int result = osum_signer_set_header(session->signer, header, detail);
    if (!result) {
        memcpy(session->header, header, OSUM_HEADER_SIZE);
        atomic_store(&session->state, OSUM_STATE_HEADER_LOADED);
        atomic_store(&session->error, OSUM_OK);
    }
    pthread_mutex_unlock(&session->command_lock);
    return result;
}

int osum_session_start(struct osum_session *session)
{
    if (!session || atomic_load(&session->state) != OSUM_STATE_HEADER_LOADED)
        return -1;
    pthread_mutex_lock(&session->command_lock);
    int result = -1;
    if (osum_crypto_reset(session->crypto, session->header + 60) != 0 ||
        osum_signer_start(session->signer) != 0 ||
        clock_gettime(CLOCK_MONOTONIC, &session->origin) != 0)
        goto out;
    memset(session->lane_down, 0, sizeof(session->lane_down));
    session->last_timestamp_us = 0;
    session->duration_us = 0;
    atomic_store(&session->head, 0);
    atomic_store(&session->tail, 0);
    atomic_store(&session->accepted, 0);
    atomic_store(&session->processed, 0);
    atomic_store(&session->error, OSUM_OK);
    atomic_store(&session->state, OSUM_STATE_RECORDING);
    atomic_store_explicit(&session->accepting, true, memory_order_release);
    result = 0;
out:
    if (result) {
        (void)osum_signer_abort(session->signer);
        atomic_store(&session->state, OSUM_STATE_ERROR);
        atomic_store(&session->error, OSUM_INTERNAL_ERROR);
    }
    pthread_mutex_unlock(&session->command_lock);
    return result;
}

void osum_session_capture_edge(struct osum_session *session, uint8_t lane, uint8_t action)
{
    if (!session || lane > 3 || action > 1 ||
        !atomic_load_explicit(&session->accepting, memory_order_acquire))
        return;
    atomic_fetch_add_explicit(&session->producers, 1u, memory_order_acquire);
    if (!atomic_load_explicit(&session->accepting, memory_order_acquire))
        goto out;
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        fail_capture(session, OSUM_CLOCK_FAULT);
        goto out;
    }
    uint64_t timestamp = elapsed_us(&session->origin, &now);
    if (timestamp == UINT64_MAX || timestamp < session->last_timestamp_us) {
        fail_capture(session, OSUM_CLOCK_FAULT);
        goto out;
    }
    const bool down = action == 0;
    if (session->lane_down[lane] == down) {
        fail_capture(session, OSUM_INVALID_EVENT);
        goto out;
    }
    unsigned sequence = atomic_load_explicit(&session->accepted, memory_order_relaxed);
    if (sequence >= osum_crypto_max_events(session->crypto)) {
        fail_capture(session, OSUM_EVENT_OVERFLOW);
        goto out;
    }
    unsigned head = atomic_load_explicit(&session->head, memory_order_relaxed);
    unsigned tail = atomic_load_explicit(&session->tail, memory_order_acquire);
    if (head - tail >= CAPTURE_QUEUE_SIZE) {
        fail_capture(session, OSUM_EVENT_OVERFLOW);
        goto out;
    }
    struct osum_event event;
    if (osum_event_encode(&event, sequence, timestamp, lane, action) != 0) {
        fail_capture(session, OSUM_INVALID_EVENT);
        goto out;
    }
    session->queue[head & CAPTURE_QUEUE_MASK] = event;
    session->lane_down[lane] = down;
    session->last_timestamp_us = timestamp;
    atomic_store_explicit(&session->head, head + 1u, memory_order_release);
    atomic_store_explicit(&session->accepted, sequence + 1u, memory_order_release);
    uint64_t one = 1;
    ssize_t notified = write(session->event_fd, &one, sizeof(one));
    if (notified < 0 && errno != EAGAIN)
        fail_capture(session, OSUM_INTERNAL_ERROR);
out:
    atomic_fetch_sub_explicit(&session->producers, 1u, memory_order_release);
}

void osum_session_input_lost(struct osum_session *session, enum osum_error error)
{
    if (!session || !atomic_load_explicit(&session->accepting, memory_order_acquire))
        return;
    atomic_fetch_add_explicit(&session->producers, 1u, memory_order_acquire);
    if (atomic_load_explicit(&session->accepting, memory_order_acquire))
        fail_capture(session, error);
    atomic_fetch_sub_explicit(&session->producers, 1u, memory_order_release);
}

int osum_session_stop(struct osum_session *session)
{
    if (!session || atomic_load(&session->state) != OSUM_STATE_RECORDING)
        return -1;
    pthread_mutex_lock(&session->command_lock);
    atomic_store_explicit(&session->accepting, false, memory_order_release);
    while (atomic_load_explicit(&session->producers, memory_order_acquire))
        sched_yield();
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        fail_capture(session, OSUM_CLOCK_FAULT);
        goto failed;
    }
    session->duration_us = elapsed_us(&session->origin, &now);
    if (session->duration_us == UINT64_MAX || session->duration_us > 1800000000ULL) {
        fail_capture(session, OSUM_CLOCK_FAULT);
        goto failed;
    }
    uint64_t one = 1;
    ssize_t notified = write(session->event_fd, &one, sizeof(one));
    if (notified < 0 && errno != EAGAIN) {
        fail_capture(session, OSUM_INTERNAL_ERROR);
        goto failed;
    }
    pthread_mutex_lock(&session->drain_lock);
    while (atomic_load(&session->processed) != atomic_load(&session->accepted) &&
           atomic_load(&session->state) != OSUM_STATE_ERROR)
        pthread_cond_wait(&session->drain_condition, &session->drain_lock);
    pthread_mutex_unlock(&session->drain_lock);
    if (atomic_load(&session->state) == OSUM_STATE_ERROR ||
        osum_crypto_finalize(session->crypto, session->trace_root, session->commitment) != 0 ||
        osum_signer_finalize(session->signer, atomic_load(&session->accepted),
                             session->duration_us, session->trace_root,
                             session->commitment) != 0) {
        fail_capture(session, OSUM_SIGN_FAILED);
        goto failed;
    }
    atomic_store(&session->state, OSUM_STATE_FINALIZED);
    pthread_mutex_unlock(&session->command_lock);
    return 0;
failed:
    atomic_store(&session->state, OSUM_STATE_ERROR);
    pthread_mutex_unlock(&session->command_lock);
    return -1;
}

int osum_session_abort(struct osum_session *session)
{
    if (!session) return -1;
    pthread_mutex_lock(&session->command_lock);
    atomic_store(&session->accepting, false);
    pthread_mutex_lock(&session->drain_lock);
    atomic_store(&session->tail, atomic_load(&session->head));
    atomic_store(&session->processed, atomic_load(&session->accepted));
    pthread_mutex_unlock(&session->drain_lock);
    int result = osum_signer_abort(session->signer);
    memset(session->header, 0, sizeof(session->header));
    memset(session->trace_root, 0, sizeof(session->trace_root));
    memset(session->commitment, 0, sizeof(session->commitment));
    atomic_store(&session->head, 0); atomic_store(&session->tail, 0);
    atomic_store(&session->accepted, 0); atomic_store(&session->processed, 0);
    if (result) {
        atomic_store(&session->error, OSUM_INTERNAL_ERROR);
        atomic_store(&session->state, OSUM_STATE_ERROR);
    } else {
        atomic_store(&session->error, OSUM_OK);
        atomic_store(&session->state, OSUM_STATE_IDLE);
    }
    session->duration_us = 0;
    pthread_mutex_unlock(&session->command_lock);
    return result;
}

int osum_session_result(struct osum_session *session, uint8_t result[OSUM_RESULT_SIZE])
{
    if (!session || atomic_load(&session->state) != OSUM_STATE_FINALIZED)
        return -1;
    return osum_signer_get_result(session->signer, result);
}

uint32_t osum_session_trace_length(struct osum_session *session)
{
    return session && atomic_load(&session->state) == OSUM_STATE_FINALIZED ?
        osum_crypto_trace_length(session->crypto) : 0;
}

int osum_session_trace_read(void *context, uint32_t offset, uint8_t *destination, size_t length)
{
    struct osum_session *session = context;
    if (!session || atomic_load(&session->state) != OSUM_STATE_FINALIZED)
        return -1;
    return osum_crypto_trace_read(session->crypto, offset, destination, length);
}
