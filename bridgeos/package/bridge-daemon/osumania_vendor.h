#ifndef OSUMANIA_VENDOR_H
#define OSUMANIA_VENDOR_H

#include "osumania_session.h"

struct osum_vendor;

struct osum_vendor *osum_vendor_start(int hidg_fd, struct osum_session *session);
/* Called only by the evdev thread. False means the live stream lost an edge. */
bool osum_vendor_edge(struct osum_vendor *vendor, uint64_t timestamp_us,
                      uint8_t lane, uint8_t action);
void osum_vendor_stop(struct osum_vendor *vendor);

#endif
