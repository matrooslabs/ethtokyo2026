#include "osumania_protocol.h"

#include <string.h>

uint16_t osum_be16_load(const uint8_t value[2])
{
    return (uint16_t)((uint16_t)value[0] << 8 | value[1]);
}

uint32_t osum_be32_load(const uint8_t value[4])
{
    return (uint32_t)value[0] << 24 | (uint32_t)value[1] << 16 |
           (uint32_t)value[2] << 8 | value[3];
}

uint64_t osum_be64_load(const uint8_t value[8])
{
    return (uint64_t)osum_be32_load(value) << 32 | osum_be32_load(value + 4);
}

void osum_be16_store(uint8_t value[2], uint16_t number)
{
    value[0] = (uint8_t)(number >> 8);
    value[1] = (uint8_t)number;
}

void osum_be32_store(uint8_t value[4], uint32_t number)
{
    value[0] = (uint8_t)(number >> 24);
    value[1] = (uint8_t)(number >> 16);
    value[2] = (uint8_t)(number >> 8);
    value[3] = (uint8_t)number;
}

void osum_be64_store(uint8_t value[8], uint64_t number)
{
    osum_be32_store(value, (uint32_t)(number >> 32));
    osum_be32_store(value + 4, (uint32_t)number);
}

_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "live input queue requires lock-free atomic indices");
_Static_assert((OSUM_LIVE_QUEUE_SIZE & (OSUM_LIVE_QUEUE_SIZE - 1u)) == 0,
               "live input queue size must be a power of two");

void osum_live_queue_init(struct osum_live_queue *queue)
{
    atomic_init(&queue->head, 0);
    atomic_init(&queue->tail, 0);
    queue->next_sequence = 0;
}

bool osum_live_enqueue(struct osum_live_queue *queue, uint64_t timestamp_us,
                       uint8_t lane, uint8_t action)
{
    const uint32_t sequence = queue->next_sequence++;
    const unsigned head = atomic_load_explicit(&queue->head, memory_order_relaxed);
    const unsigned tail = atomic_load_explicit(&queue->tail, memory_order_acquire);
    if (head - tail == OSUM_LIVE_QUEUE_SIZE)
        return false;
    queue->edges[head & (OSUM_LIVE_QUEUE_SIZE - 1u)] =
        (struct osum_live_edge){sequence, timestamp_us, lane, action};
    atomic_store_explicit(&queue->head, head + 1u, memory_order_release);
    return true;
}

bool osum_live_dequeue(struct osum_live_queue *queue, struct osum_live_edge *edge)
{
    const unsigned tail = atomic_load_explicit(&queue->tail, memory_order_relaxed);
    if (tail == atomic_load_explicit(&queue->head, memory_order_acquire))
        return false;
    *edge = queue->edges[tail & (OSUM_LIVE_QUEUE_SIZE - 1u)];
    atomic_store_explicit(&queue->tail, tail + 1u, memory_order_release);
    return true;
}

void osum_live_discard(struct osum_live_queue *queue)
{
    atomic_store_explicit(&queue->tail,
                          atomic_load_explicit(&queue->head, memory_order_acquire),
                          memory_order_release);
}

void osum_live_report(const struct osum_live_edge *edge,
                      uint8_t report[OSUM_REPORT_SIZE])
{
    memset(report, 0, OSUM_REPORT_SIZE);
    report[0] = OSUM_MAGIC;
    report[1] = OSUM_VERSION;
    report[2] = OSUM_LIVE_EDGE;
    report[3] = OSUM_FLAG_LIVE;
    osum_be32_store(report + 12, OSUM_EVENT_SIZE);
    osum_be32_store(report + OSUM_PACKET_HEADER_SIZE, edge->sequence);
    osum_be64_store(report + OSUM_PACKET_HEADER_SIZE + 4, edge->timestamp_us);
    report[OSUM_PACKET_HEADER_SIZE + 12] = edge->lane;
    report[OSUM_PACKET_HEADER_SIZE + 13] = edge->action;
}

uint32_t osum_request_length(uint8_t message_type, bool *known)
{
    *known = true;
    switch (message_type) {
    case OSUM_SET_HEADER:
        return OSUM_HEADER_SIZE;
    case OSUM_GET_INFO:
    case OSUM_GET_STATUS:
    case OSUM_START:
    case OSUM_STOP:
    case OSUM_ABORT:
    case OSUM_GET_RESULT:
    case OSUM_GET_TRACE:
        return 0;
    default:
        *known = false;
        return 0;
    }
}

void osum_rx_reset(struct osum_rx *rx)
{
    memset(rx, 0, sizeof(*rx));
}

static bool all_zero(const uint8_t *data, size_t length)
{
    uint8_t combined = 0;
    for (size_t i = 0; i < length; ++i)
        combined |= data[i];
    return combined == 0;
}

static enum osum_error fail(struct osum_rx *rx, enum osum_error error)
{
    osum_rx_reset(rx);
    return error;
}

enum osum_error osum_rx_report(struct osum_rx *rx, const uint8_t report[OSUM_REPORT_SIZE],
                               struct osum_request *completed)
{
    memset(completed, 0, sizeof(*completed));
    if (report[0] != OSUM_MAGIC)
        return fail(rx, OSUM_BAD_LENGTH);
    if (report[1] != OSUM_VERSION)
        return fail(rx, OSUM_BAD_PROTOCOL_VERSION);
    if (report[3] != 0)
        return fail(rx, OSUM_BAD_LENGTH);

    const uint8_t type = report[2];
    const uint32_t transfer = osum_be32_load(report + 4);
    const uint32_t offset = osum_be32_load(report + 8);
    const uint32_t total = osum_be32_load(report + 12);
    bool known;
    const uint32_t expected = osum_request_length(type, &known);
    if (!known || transfer == 0 || total > OSUM_MAX_LOGICAL_SIZE || total != expected)
        return fail(rx, OSUM_BAD_LENGTH);

    if (total == 0) {
        if (offset != 0)
            return fail(rx, OSUM_BAD_FRAGMENT_OFFSET);
        if (!all_zero(report + OSUM_PACKET_HEADER_SIZE, OSUM_PACKET_PAYLOAD_SIZE))
            return fail(rx, OSUM_BAD_LENGTH);
        if (rx->active)
            return fail(rx, OSUM_BAD_FRAGMENT_OFFSET);
        completed->message_type = type;
        completed->transfer_id = transfer;
        return OSUM_OK;
    }

    if (offset >= total || offset % OSUM_PACKET_PAYLOAD_SIZE != 0)
        return fail(rx, OSUM_BAD_FRAGMENT_OFFSET);
    const uint32_t remaining = total - offset;
    const size_t fragment = remaining < OSUM_PACKET_PAYLOAD_SIZE ? remaining : OSUM_PACKET_PAYLOAD_SIZE;
    if (!all_zero(report + OSUM_PACKET_HEADER_SIZE + fragment,
                  OSUM_PACKET_PAYLOAD_SIZE - fragment))
        return fail(rx, OSUM_BAD_LENGTH);

    if (!rx->active) {
        if (offset != 0 || total > sizeof(rx->data))
            return fail(rx, offset ? OSUM_BAD_FRAGMENT_OFFSET : OSUM_BAD_LENGTH);
        rx->active = true;
        rx->message_type = type;
        rx->transfer_id = transfer;
        rx->total_length = total;
    } else if (type != rx->message_type || transfer != rx->transfer_id ||
               total != rx->total_length) {
        return fail(rx, OSUM_BAD_FRAGMENT_OFFSET);
    }
    if (offset != rx->next_offset)
        return fail(rx, OSUM_BAD_FRAGMENT_OFFSET);

    memcpy(rx->data + offset, report + OSUM_PACKET_HEADER_SIZE, fragment);
    rx->next_offset += (uint32_t)fragment;
    if (rx->next_offset != total)
        return OSUM_OK;

    completed->message_type = rx->message_type;
    completed->transfer_id = rx->transfer_id;
    completed->length = rx->total_length;
    completed->payload = rx->data;
    rx->active = false;
    rx->next_offset = 0;
    rx->total_length = 0;
    rx->transfer_id = 0;
    rx->message_type = 0;
    return OSUM_OK;
}

void osum_tx_begin(struct osum_tx *tx, uint8_t message_type, uint8_t flags,
                   uint32_t transfer_id, uint32_t total_length,
                   osum_read_fn read, void *context)
{
    memset(tx, 0, sizeof(*tx));
    tx->active = true;
    tx->message_type = message_type;
    tx->flags = flags;
    tx->transfer_id = transfer_id;
    tx->total_length = total_length;
    tx->read = read;
    tx->context = context;
}

int osum_tx_next(struct osum_tx *tx, uint8_t report[OSUM_REPORT_SIZE])
{
    if (!tx->active)
        return 0;
    memset(report, 0, OSUM_REPORT_SIZE);
    report[0] = OSUM_MAGIC;
    report[1] = OSUM_VERSION;
    report[2] = tx->message_type;
    report[3] = tx->flags;
    osum_be32_store(report + 4, tx->transfer_id);
    osum_be32_store(report + 8, tx->offset);
    osum_be32_store(report + 12, tx->total_length);

    if (tx->total_length == 0) {
        if (tx->zero_sent)
            return 0;
        tx->zero_sent = true;
        tx->active = false;
        return 1;
    }

    const uint32_t remaining = tx->total_length - tx->offset;
    const size_t fragment = remaining < OSUM_PACKET_PAYLOAD_SIZE ? remaining : OSUM_PACKET_PAYLOAD_SIZE;
    if (!tx->read || tx->read(tx->context, tx->offset,
                              report + OSUM_PACKET_HEADER_SIZE, fragment) != 0) {
        tx->active = false;
        return -1;
    }
    tx->offset += (uint32_t)fragment;
    if (tx->offset == tx->total_length)
        tx->active = false;
    return 1;
}

void osum_error_payload(uint8_t payload[OSUM_PACKET_PAYLOAD_SIZE], enum osum_error error,
                        enum osum_state state, uint8_t detail, const char *diagnostic,
                        uint32_t *length)
{
    memset(payload, 0, OSUM_PACKET_PAYLOAD_SIZE);
    osum_be16_store(payload, (uint16_t)error);
    payload[2] = (uint8_t)state;
    payload[3] = detail;
    size_t size = 4;
    if (diagnostic) {
        const size_t available = OSUM_PACKET_PAYLOAD_SIZE - size;
        size_t text = 0;
        while (text < available && diagnostic[text])
            ++text;
        memcpy(payload + size, diagnostic, text);
        size += text;
    }
    *length = (uint32_t)size;
}
