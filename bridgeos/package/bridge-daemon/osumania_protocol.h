#ifndef OSUMANIA_PROTOCOL_H
#define OSUMANIA_PROTOCOL_H

#include <stdbool.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

#define OSUM_REPORT_SIZE 64u
#define OSUM_PACKET_HEADER_SIZE 16u
#define OSUM_PACKET_PAYLOAD_SIZE 48u
#define OSUM_MAX_LOGICAL_SIZE 700000u
#define OSUM_HEADER_SIZE 292u
#define OSUM_RESULT_SIZE 465u
#define OSUM_INFO_SIZE 128u
#define OSUM_STATUS_SIZE 16u
#define OSUM_EVENT_SIZE 14u
#define OSUM_MAX_EVENTS 50000u
#define OSUM_LIVE_QUEUE_SIZE 1024u
#define OSUM_RX_MAX OSUM_HEADER_SIZE

#define OSUM_MAGIC 0x4du
#define OSUM_VERSION 0x01u
#define OSUM_FLAG_RESPONSE 0x01u
#define OSUM_FLAG_ERROR 0x02u
#define OSUM_FLAG_LIVE 0x04u

enum osum_message_type {
    OSUM_GET_INFO = 0x01,
    OSUM_GET_STATUS = 0x02,
    OSUM_SET_HEADER = 0x10,
    OSUM_START = 0x11,
    OSUM_STOP = 0x12,
    OSUM_ABORT = 0x13,
    OSUM_GET_RESULT = 0x20,
    OSUM_GET_TRACE = 0x21,
    OSUM_LIVE_EDGE = 0x30,
};

enum osum_state {
    OSUM_STATE_IDLE = 0,
    OSUM_STATE_HEADER_LOADED = 1,
    OSUM_STATE_RECORDING = 2,
    OSUM_STATE_FINALIZED = 3,
    OSUM_STATE_ERROR = 255,
};

enum osum_error {
    OSUM_OK = 0,
    OSUM_BAD_PROTOCOL_VERSION = 0x0001,
    OSUM_BAD_STATE = 0x0002,
    OSUM_BAD_LENGTH = 0x0003,
    OSUM_BAD_FRAGMENT_OFFSET = 0x0004,
    OSUM_HEADER_MISMATCH = 0x0005,
    OSUM_EVENT_OVERFLOW = 0x0006,
    OSUM_SIGN_FAILED = 0x0007,
    OSUM_NOT_READY = 0x0008,
    OSUM_INVALID_EVENT = 0x0009,
    OSUM_CLOCK_FAULT = 0x000a,
    OSUM_INTERNAL_ERROR = 0x00ff,
};

enum osum_header_detail {
    OSUM_HEADER_DEVICE = 1,
    OSUM_HEADER_BITSTREAM = 2,
    OSUM_HEADER_POLICY = 3,
    OSUM_HEADER_SRS = 4,
};

struct osum_packet {
    uint8_t message_type;
    uint8_t flags;
    uint32_t transfer_id;
    uint32_t offset;
    uint32_t total_length;
    size_t fragment_length;
    const uint8_t *payload;
};

struct osum_rx {
    bool active;
    uint8_t message_type;
    uint32_t transfer_id;
    uint32_t total_length;
    uint32_t next_offset;
    uint8_t data[OSUM_RX_MAX];
};

struct osum_request {
    uint8_t message_type;
    uint32_t transfer_id;
    uint32_t length;
    const uint8_t *payload;
};

typedef int (*osum_read_fn)(void *context, uint32_t offset, uint8_t *dst, size_t length);

struct osum_tx {
    bool active;
    bool zero_sent;
    uint8_t message_type;
    uint8_t flags;
    uint32_t transfer_id;
    uint32_t total_length;
    uint32_t offset;
    osum_read_fn read;
    void *context;
};

/* One evdev producer and one vendor-HID consumer. Sequence is per daemon vendor
 * lifetime, not per paid capture; rejected edges still consume a sequence. */
struct osum_live_edge {
    uint32_t sequence;
    uint64_t timestamp_us;
    uint8_t lane;
    uint8_t action;
};

struct osum_live_queue {
    atomic_uint head;
    atomic_uint tail;
    uint32_t next_sequence; /* producer only */
    struct osum_live_edge edges[OSUM_LIVE_QUEUE_SIZE];
};

void osum_live_queue_init(struct osum_live_queue *queue);
bool osum_live_enqueue(struct osum_live_queue *queue, uint64_t timestamp_us,
                       uint8_t lane, uint8_t action);
bool osum_live_dequeue(struct osum_live_queue *queue, struct osum_live_edge *edge);
void osum_live_discard(struct osum_live_queue *queue);
void osum_live_report(const struct osum_live_edge *edge,
                      uint8_t report[OSUM_REPORT_SIZE]);

uint16_t osum_be16_load(const uint8_t value[2]);
uint32_t osum_be32_load(const uint8_t value[4]);
uint64_t osum_be64_load(const uint8_t value[8]);
void osum_be16_store(uint8_t value[2], uint16_t number);
void osum_be32_store(uint8_t value[4], uint32_t number);
void osum_be64_store(uint8_t value[8], uint64_t number);

uint32_t osum_request_length(uint8_t message_type, bool *known);
void osum_rx_reset(struct osum_rx *rx);
enum osum_error osum_rx_report(struct osum_rx *rx, const uint8_t report[OSUM_REPORT_SIZE],
                               struct osum_request *completed);
void osum_tx_begin(struct osum_tx *tx, uint8_t message_type, uint8_t flags,
                   uint32_t transfer_id, uint32_t total_length,
                   osum_read_fn read, void *context);
int osum_tx_next(struct osum_tx *tx, uint8_t report[OSUM_REPORT_SIZE]);
void osum_error_payload(uint8_t payload[OSUM_PACKET_PAYLOAD_SIZE], enum osum_error error,
                        enum osum_state state, uint8_t detail, const char *diagnostic,
                        uint32_t *length);

#endif
