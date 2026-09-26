#ifndef USER_TA_HEADER_DEFINES_H
#define USER_TA_HEADER_DEFINES_H

#include "osumania_ta.h"

#define TA_UUID OSUMANIA_TA_UUID
#define TA_FLAGS (TA_FLAG_SINGLE_INSTANCE | TA_FLAG_INSTANCE_KEEP_ALIVE)
#define TA_STACK_SIZE (16 * 1024)
#define TA_DATA_SIZE (96 * 1024)
#define TA_DESCRIPTION "osu!mania constrained session signer"
#define TA_VERSION "1.0"

#endif
