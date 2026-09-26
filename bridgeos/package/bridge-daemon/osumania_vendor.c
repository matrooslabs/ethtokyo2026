#define _GNU_SOURCE
#include "osumania_vendor.h"
#include "osumania_protocol.h"

#include <pthread.h>
#include <poll.h>
#include <stdatomic.h>
#include <unistd.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct memory_payload {
    const uint8_t *data;
    uint32_t length;
};

struct osum_vendor {
    int fd;
    struct osum_session *session;
    pthread_t thread;
    atomic_bool running;
    struct osum_rx rx;
};

static int memory_read(void *context, uint32_t offset, uint8_t *destination, size_t length)
{
    const struct memory_payload *payload = context;
    if (offset > payload->length || length > payload->length - offset)
        return -1;
    memcpy(destination, payload->data + offset, length);
    return 0;
}

static int write_report(struct osum_vendor *vendor, const uint8_t report[OSUM_REPORT_SIZE])
{
    while (atomic_load(&vendor->running)) {
        ssize_t size = write(vendor->fd, report, OSUM_REPORT_SIZE);
        if (size == OSUM_REPORT_SIZE)
            return 0;
        if (size < 0 && (errno == EAGAIN || errno == EINTR)) {
            struct pollfd descriptor = { .fd = vendor->fd, .events = POLLOUT };
            if (poll(&descriptor, 1, 1000) < 0 && errno != EINTR)
                return -1;
            continue;
        }
        return -1;
    }
    return -1;
}

static int transmit(struct osum_vendor *vendor, uint8_t message_type, uint8_t flags,
                    uint32_t transfer_id, uint32_t length,
                    osum_read_fn read, void *context)
{
    struct osum_tx tx;
    osum_tx_begin(&tx, message_type, flags, transfer_id, length, read, context);
    uint8_t report[OSUM_REPORT_SIZE];
    int status;
    while ((status = osum_tx_next(&tx, report)) > 0)
        if (write_report(vendor, report) != 0)
            return -1;
    return status;
}

static int error_response(struct osum_vendor *vendor, uint8_t message_type,
                          uint32_t transfer_id, enum osum_error error,
                          uint8_t detail, const char *diagnostic)
{
    uint8_t data[OSUM_PACKET_PAYLOAD_SIZE];
    uint32_t length;
    struct osum_session_status status;
    osum_session_status(vendor->session, &status);
    osum_error_payload(data, error, status.state, detail, diagnostic, &length);
    struct memory_payload payload = { data, length };
    return transmit(vendor, message_type, OSUM_FLAG_RESPONSE | OSUM_FLAG_ERROR,
                    transfer_id, length, memory_read, &payload);
}

static bool state_is(struct osum_vendor *vendor, enum osum_state expected)
{
    struct osum_session_status status;
    osum_session_status(vendor->session, &status);
    return status.state == expected;
}

static int command(struct osum_vendor *vendor, const struct osum_request *request)
{
    uint8_t data[OSUM_RESULT_SIZE];
    uint32_t length = 0;
    uint8_t detail = 0;
    int status = 0;
    switch (request->message_type) {
    case OSUM_GET_INFO: {
        struct osum_session_info info;
        uint8_t detail;
        uint32_t tee_result, tee_origin;
        if (osum_session_info(vendor->session, &info, &detail,
                              &tee_result, &tee_origin) != 0) {
            char diagnostic[48];
            if (detail == OSUM_HEADER_SRS)
                snprintf(diagnostic, sizeof(diagnostic), "SRS unavailable");
            else if (tee_result)
                snprintf(diagnostic, sizeof(diagnostic), "TEE 0x%08x origin %u",
                         tee_result, tee_origin);
            else
                snprintf(diagnostic, sizeof(diagnostic), "TEE signer unavailable");
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_NOT_READY, detail, diagnostic);
        }
        osum_be16_store(data, 1);
        osum_be16_store(data + 2, OSUM_REPORT_SIZE);
        osum_be32_store(data + 4, 0);
        memcpy(data + 8, info.device, 20);
        memcpy(data + 28, info.bitstream_hash, 32);
        memcpy(data + 60, info.input_policy_hash, 32);
        memcpy(data + 92, info.srs_hash, 32);
        osum_be32_store(data + 124, info.max_events);
        length = OSUM_INFO_SIZE;
        break;
    }
    case OSUM_GET_STATUS: {
        struct osum_session_status current;
        osum_session_status(vendor->session, &current);
        memset(data, 0, OSUM_STATUS_SIZE);
        data[0] = (uint8_t)current.state;
        osum_be16_store(data + 2, (uint16_t)current.last_error);
        osum_be32_store(data + 4, current.event_count);
        osum_be64_store(data + 8, current.elapsed_us);
        length = OSUM_STATUS_SIZE;
        break;
    }
    case OSUM_SET_HEADER:
        if (!state_is(vendor, OSUM_STATE_IDLE))
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_BAD_STATE, 0, NULL);
        if (osum_session_set_header(vendor->session, request->payload, &detail) != 0)
            return error_response(vendor, request->message_type, request->transfer_id,
                                  detail ? OSUM_HEADER_MISMATCH : OSUM_NOT_READY,
                                  detail, NULL);
        break;
    case OSUM_START:
        if (!state_is(vendor, OSUM_STATE_HEADER_LOADED))
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_BAD_STATE, 0, NULL);
        if (osum_session_start(vendor->session) != 0)
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_INTERNAL_ERROR, 0, NULL);
        break;
    case OSUM_STOP:
        if (!state_is(vendor, OSUM_STATE_RECORDING))
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_BAD_STATE, 0, NULL);
        if (osum_session_stop(vendor->session) != 0)
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_SIGN_FAILED, 0, NULL);
        break;
    case OSUM_ABORT:
        if (osum_session_abort(vendor->session) != 0)
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_INTERNAL_ERROR, 0, NULL);
        break;
    case OSUM_GET_RESULT:
        if (!state_is(vendor, OSUM_STATE_FINALIZED))
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_BAD_STATE, 0, NULL);
        if (osum_session_result(vendor->session, data) != 0)
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_NOT_READY, 0, NULL);
        length = OSUM_RESULT_SIZE;
        break;
    case OSUM_GET_TRACE:
        if (!state_is(vendor, OSUM_STATE_FINALIZED))
            return error_response(vendor, request->message_type, request->transfer_id,
                                  OSUM_BAD_STATE, 0, NULL);
        length = osum_session_trace_length(vendor->session);
        return transmit(vendor, request->message_type, OSUM_FLAG_RESPONSE,
                        request->transfer_id, length,
                        osum_session_trace_read, vendor->session);
    default:
        status = -1;
    }
    if (status)
        return error_response(vendor, request->message_type, request->transfer_id,
                              OSUM_BAD_LENGTH, 0, NULL);
    struct memory_payload payload = { data, length };
    return transmit(vendor, request->message_type, OSUM_FLAG_RESPONSE,
                    request->transfer_id, length, memory_read, &payload);
}

static void disconnect(struct osum_vendor *vendor)
{
    osum_rx_reset(&vendor->rx);
    struct osum_session_status status;
    osum_session_status(vendor->session, &status);
    if (status.state == OSUM_STATE_RECORDING)
        (void)osum_session_abort(vendor->session);
}

static void *vendor_thread(void *argument)
{
    struct osum_vendor *vendor = argument;
    while (atomic_load(&vendor->running)) {
        struct pollfd descriptor = { .fd = vendor->fd, .events = POLLIN };
        int ready = poll(&descriptor, 1, 1000);
        if (ready < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (!ready) continue;
        if (descriptor.revents & (POLLHUP | POLLERR | POLLNVAL)) {
            disconnect(vendor);
            usleep(10000);
            continue;
        }
        if (!(descriptor.revents & POLLIN)) continue;
        uint8_t report[OSUM_REPORT_SIZE];
        ssize_t size = read(vendor->fd, report, sizeof(report));
        if (size <= 0) {
            disconnect(vendor);
            usleep(10000);
            continue;
        }
        if (size != OSUM_REPORT_SIZE) {
            osum_rx_reset(&vendor->rx);
            continue;
        }
        struct osum_request request;
        enum osum_error error = osum_rx_report(&vendor->rx, report, &request);
        if (error != OSUM_OK) {
            if (report[0] == OSUM_MAGIC && osum_be32_load(report + 4) != 0)
                (void)error_response(vendor, report[2], osum_be32_load(report + 4), error, 0, NULL);
            continue;
        }
        if (request.transfer_id && command(vendor, &request) != 0)
            disconnect(vendor);
    }
    return NULL;
}

struct osum_vendor *osum_vendor_start(int hidg_fd, struct osum_session *session)
{
    struct osum_vendor *vendor = calloc(1, sizeof(*vendor));
    if (!vendor) return NULL;
    vendor->fd = hidg_fd;
    vendor->session = session;
    atomic_init(&vendor->running, true);
    osum_rx_reset(&vendor->rx);
    if (pthread_create(&vendor->thread, NULL, vendor_thread, vendor) != 0) {
        free(vendor);
        return NULL;
    }
    return vendor;
}

void osum_vendor_stop(struct osum_vendor *vendor)
{
    if (!vendor) return;
    atomic_store(&vendor->running, false);
    pthread_join(vendor->thread, NULL);
    free(vendor);
}
