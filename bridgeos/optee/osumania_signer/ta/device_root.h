#ifndef OSUMANIA_DEVICE_ROOT_H
#define OSUMANIA_DEVICE_ROOT_H

#include <tee_internal_api.h>

TEE_Result osumania_platform_root_secret(uint8_t output[32]);

#endif
