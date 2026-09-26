#ifndef OSUMANIA_VENDOR_H
#define OSUMANIA_VENDOR_H

#include "osumania_session.h"

struct osum_vendor;

struct osum_vendor *osum_vendor_start(int hidg_fd, struct osum_session *session);
void osum_vendor_stop(struct osum_vendor *vendor);

#endif
