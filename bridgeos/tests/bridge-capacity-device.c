/* Host-only Vendor HID boundary harness. Never install this or its known-scalar bank. */
#define _POSIX_C_SOURCE 200809L
#include "osumania_session.h"
#include "osumania_vendor.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc != 4) {
        fprintf(stderr, "usage: %s SOCKET_FD SRS_PATH INTERVAL_US\n", argv[0]);
        return 2;
    }
    char *end = NULL;
    long descriptor = strtol(argv[1], &end, 10);
    if (*end || descriptor < 0 || descriptor > 1024) return 2;
    unsigned long interval = strtoul(argv[3], &end, 10);
    if (*end || interval > 1000000) return 2;

    /* Explicitly insecure host-only signer. No TA and no device secret. */
    if (setenv("DEV_INSECURE_PRIVATE_KEY",
               "0000000000000000000000000000000000000000000000000000000000000001", 1) ||
        setenv("OSUMANIA_BITSTREAM_HASH",
               "0404040404040404040404040404040404040404040404040404040404040404", 1))
        return 2;
    struct osum_session *session = osum_session_create(argv[2], "dev-insecure");
    struct osum_vendor *vendor = session ? osum_vendor_start((int)descriptor, session) : NULL;
    if (!vendor) return 2;
    puts("READY"); fflush(stdout);
    char command[64];
    while (fgets(command, sizeof(command), stdin)) {
        unsigned count;
        if (sscanf(command, "CAPTURE %u", &count) != 1 || count > 50001u)
            break;
        struct timespec pause = { .tv_sec = 0, .tv_nsec = (long)interval * 1000L };
        for (unsigned i = 0; i < count; ++i) {
            osum_session_capture_edge(session, 0, (uint8_t)(i & 1u));
            if (interval && i + 1u < count) {
                while (nanosleep(&pause, &pause) && errno == EINTR) { }
                pause.tv_sec = 0;
                pause.tv_nsec = (long)interval * 1000L;
            }
        }
        struct osum_session_status status;
        osum_session_status(session, &status);
        printf("CAPTURED %u %u %u\n", status.event_count, (unsigned)status.state,
               (unsigned)status.last_error);
        fflush(stdout);
    }
    osum_vendor_stop(vendor);
    osum_session_destroy(session);
    close((int)descriptor);
    return 0;
}
