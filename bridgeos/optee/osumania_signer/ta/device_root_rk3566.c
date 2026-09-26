#include "device_root.h"

#include <pta_system.h>

TEE_Result osumania_platform_root_secret(uint8_t output[32])
{
    static const uint8_t label[] = "OSUMANIA_DEVICE_SECP256K1_V1";
    const TEE_UUID uuid = PTA_SYSTEM_UUID;
    TEE_TASessionHandle session = TEE_HANDLE_NULL;
    uint32_t origin = 0;
    TEE_Result status = TEE_OpenTASession(&uuid, TEE_TIMEOUT_INFINITE, 0,
                                           NULL, &session, &origin);
    if (status != TEE_SUCCESS) {
        TEE_MemFill(output, 0, 32);
        return status;
    }
    TEE_Param params[4] = { };
    params[0].memref.buffer = (void *)label;
    params[0].memref.size = sizeof(label) - 1;
    params[1].memref.buffer = output;
    params[1].memref.size = 32;
    status = TEE_InvokeTACommand(session, TEE_TIMEOUT_INFINITE,
        PTA_SYSTEM_DERIVE_TA_UNIQUE_KEY,
        TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_INPUT, TEE_PARAM_TYPE_MEMREF_OUTPUT,
                        TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE),
        params, &origin);
    TEE_CloseTASession(session);
    if (status != TEE_SUCCESS || params[1].memref.size != 32) {
        TEE_MemFill(output, 0, 32);
        return status == TEE_SUCCESS ? TEE_ERROR_BAD_FORMAT : status;
    }
    return TEE_SUCCESS;
}
