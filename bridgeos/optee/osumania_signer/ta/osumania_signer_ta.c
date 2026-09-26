#include <tee_internal_api.h>
#include <tee_internal_api_extensions.h>

#include "device_root.h"
#include "keccak256.h"
#include "osumania_ta.h"
#include "third_party/micro-ecc/uECC.h"

#include <string.h>
typedef size_t tee_output_length_t;

#define STATE_IDLE 0u
#define STATE_HEADER_LOADED 1u
#define STATE_RECORDING 2u
#define STATE_FINALIZED 3u
#define STATE_ERROR 255u

#ifndef OSUMANIA_PROVISIONED_SRS
#define OSUMANIA_PROVISIONED_SRS 0
#endif
static const uint8_t expected_policy[32] = {
    0x1d,0xd3,0xe7,0x15,0x32,0x31,0x9b,0xcc,0xa3,0x1f,0x8f,0x24,0x8b,0xae,0x6a,0x8c,
    0x8e,0x05,0x7c,0xdd,0xbd,0x69,0x2b,0xfa,0xdf,0x3e,0xb0,0x6e,0x0a,0xe7,0x54,0x60,
};

#if defined(CFG_OSUMANIA_DEV_INSECURE_KEY)
static const uint8_t expected_bitstream[32] = {
    0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,
    0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,
};
#else
#ifndef OSUMANIA_PROVISIONED_BITSTREAM_HASH
#error "Production TA requires OSUMANIA_PROVISIONED_BITSTREAM_HASH (32-byte initializer)"
#endif
static const uint8_t expected_bitstream[32] = OSUMANIA_PROVISIONED_BITSTREAM_HASH;
#endif
static uint8_t private_key[32];
static uint8_t device_address[20];
static uint8_t state;
static TEE_Result initialization_status;
static uint8_t header[OSUMANIA_TA_HEADER_SIZE];
static uint8_t result[OSUMANIA_TA_RESULT_SIZE];

static void be32_store(uint8_t out[4], uint32_t value)
{
    out[0] = value >> 24; out[1] = value >> 16; out[2] = value >> 8; out[3] = value;
}

static uint32_t be32_load(const uint8_t in[4])
{
    return (uint32_t)in[0] << 24 | (uint32_t)in[1] << 16 | (uint32_t)in[2] << 8 | in[3];
}

static uint64_t be64_load(const uint8_t in[8])
{
    return (uint64_t)be32_load(in) << 32 | be32_load(in + 4);
}

static TEE_Result sha256(const void *data, size_t length, uint8_t output[32])
{
    TEE_OperationHandle operation = TEE_HANDLE_NULL;
    tee_output_length_t output_length = 32;
    TEE_Result status = TEE_AllocateOperation(&operation, TEE_ALG_SHA256, TEE_MODE_DIGEST, 0);
    if (status == TEE_SUCCESS)
        status = TEE_DigestDoFinal(operation, data, length, output, &output_length);
    TEE_FreeOperation(operation);
    if (status == TEE_SUCCESS && output_length != 32)
        status = TEE_ERROR_BAD_FORMAT;
    return status;
}

static TEE_Result hmac_sha256(const uint8_t key[32], const void *data, size_t length,
                              uint8_t output[32])
{
    TEE_ObjectHandle object = TEE_HANDLE_NULL;
    TEE_OperationHandle operation = TEE_HANDLE_NULL;
    TEE_Attribute attribute;
    tee_output_length_t output_length = 32;
    TEE_Result status = TEE_AllocateTransientObject(TEE_TYPE_HMAC_SHA256, 256, &object);
    if (status != TEE_SUCCESS) goto out;
    TEE_InitRefAttribute(&attribute, TEE_ATTR_SECRET_VALUE, key, 32);
    status = TEE_PopulateTransientObject(object, &attribute, 1);
    if (status != TEE_SUCCESS) goto out;
    status = TEE_AllocateOperation(&operation, TEE_ALG_HMAC_SHA256, TEE_MODE_MAC, 256);
    if (status != TEE_SUCCESS) goto out;
    status = TEE_SetOperationKey(operation, object);
    if (status != TEE_SUCCESS) goto out;
    TEE_MACInit(operation, NULL, 0);
    status = TEE_MACComputeFinal(operation, data, length, output, &output_length);
out:
    TEE_FreeOperation(operation);
    TEE_FreeTransientObject(object);
    if (status == TEE_SUCCESS && output_length != 32)
        status = TEE_ERROR_BAD_FORMAT;
    return status;
}

static TEE_Result derive_key(void)
{
    static const uint8_t info[] = "OSUMANIA_DEVICE_SECP256K1_V1";
    uint8_t root[32] = {0}, zero_salt[32] = {0}, prk[32] = {0};
    uint8_t data[sizeof(info) + 4] = {0};
    TEE_Result status = osumania_platform_root_secret(root);
    if (status != TEE_SUCCESS) {
        TEE_MemFill(root, 0, sizeof(root));
        return status;
    }
    status = hmac_sha256(zero_salt, root, sizeof(root), prk);
    TEE_MemFill(root, 0, sizeof(root));
    if (status != TEE_SUCCESS) goto out;
    TEE_MemMove(data, info, sizeof(info) - 1);
    for (uint32_t counter = 0; counter != UINT32_MAX; ++counter) {
        be32_store(data + sizeof(info) - 1, counter);
        data[sizeof(info) + 3] = 1; /* HKDF block counter. */
        status = hmac_sha256(prk, data, sizeof(data), private_key);
        if (status != TEE_SUCCESS) goto out;
        {
            uint8_t public_key[64], hash[32];
            if (!uECC_compute_public_key(private_key, public_key, uECC_secp256k1())) {
                TEE_MemFill(private_key, 0, sizeof(private_key));
                continue;
            }
            osum_keccak256(public_key, sizeof(public_key), hash);
            TEE_MemMove(device_address, hash + 12, 20);
            TEE_MemFill(public_key, 0, sizeof(public_key));
            TEE_MemFill(hash, 0, sizeof(hash));
            status = TEE_SUCCESS;
            goto out;
        }
    }
    status = TEE_ERROR_SECURITY;
out:
    if (status != TEE_SUCCESS) {
        TEE_MemFill(private_key, 0, sizeof(private_key));
        TEE_MemFill(device_address, 0, sizeof(device_address));
    }
    TEE_MemFill(prk, 0, sizeof(prk));
    TEE_MemFill(data, 0, sizeof(data));
    return status;
}

struct tee_sha_context {
    uECC_HashContext base;
    TEE_OperationHandle operation;
    uint8_t scratch[160];
};

static void hash_init(const uECC_HashContext *base)
{
    struct tee_sha_context *context = (struct tee_sha_context *)base;
    if (context->operation == TEE_HANDLE_NULL)
        (void)TEE_AllocateOperation(&context->operation, TEE_ALG_SHA256, TEE_MODE_DIGEST, 0);
    else
        TEE_ResetOperation(context->operation);
}

static void hash_update(const uECC_HashContext *base, const uint8_t *data, unsigned length)
{
    struct tee_sha_context *context = (struct tee_sha_context *)base;
    TEE_DigestUpdate(context->operation, data, length);
}

static void hash_finish(const uECC_HashContext *base, uint8_t *output)
{
    struct tee_sha_context *context = (struct tee_sha_context *)base;
    tee_output_length_t length = 32;
    (void)TEE_DigestDoFinal(context->operation, NULL, 0, output, &length);
}

static TEE_Result sign_digest(const uint8_t digest[32], uint8_t signature[65])
{
    struct tee_sha_context context = {
        .base = { hash_init, hash_update, hash_finish, 64, 32, NULL },
        .operation = TEE_HANDLE_NULL,
    };
    context.base.tmp = context.scratch;
    uint8_t recovery_id = 0;
    int ok = uECC_sign_deterministic_recoverable(private_key, digest, 32,
                                                  &context.base, signature,
                                                  &recovery_id, uECC_secp256k1());
    TEE_FreeOperation(context.operation);
    TEE_MemFill(&context, 0, sizeof(context));
    if (!ok || recovery_id > 1) return TEE_ERROR_SECURITY;
    signature[64] = (uint8_t)(27 + recovery_id);
    return TEE_SUCCESS;
}

TEE_Result TA_CreateEntryPoint(void)
{
    state = STATE_ERROR;
    TEE_MemFill(header, 0, sizeof(header));
    TEE_MemFill(result, 0, sizeof(result));
    initialization_status = derive_key();
    if (initialization_status == TEE_SUCCESS)
        state = STATE_IDLE;
    return TEE_SUCCESS;
}

void TA_DestroyEntryPoint(void)
{
    TEE_MemFill(private_key, 0, sizeof(private_key));
    TEE_MemFill(header, 0, sizeof(header));
    TEE_MemFill(result, 0, sizeof(result));
}

TEE_Result TA_OpenSessionEntryPoint(uint32_t types, TEE_Param params[4], void **context)
{
    (void)types; (void)params; (void)context;
    return TEE_SUCCESS;
}

void TA_CloseSessionEntryPoint(void *context) { (void)context; }

static TEE_Result get_device(uint32_t types, TEE_Param params[4])
{
    if (initialization_status != TEE_SUCCESS)
        return initialization_status;
    if (types != TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_OUTPUT, TEE_PARAM_TYPE_NONE,
                                 TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE))
        return TEE_ERROR_BAD_PARAMETERS;
    if (params[0].memref.size < OSUMANIA_TA_DEVICE_INFO_SIZE) {
        params[0].memref.size = OSUMANIA_TA_DEVICE_INFO_SIZE;
        return TEE_ERROR_SHORT_BUFFER;
    }
    TEE_MemMove(params[0].memref.buffer, device_address, 20);
    TEE_MemMove((uint8_t *)params[0].memref.buffer + 20, expected_bitstream, 32);
    params[0].memref.size = OSUMANIA_TA_DEVICE_INFO_SIZE;
    return TEE_SUCCESS;
}

static TEE_Result set_header(uint32_t types, TEE_Param params[4])
{
    if (types != TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_INPUT, TEE_PARAM_TYPE_VALUE_OUTPUT,
                                 TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE) ||
        params[0].memref.size != OSUMANIA_TA_HEADER_SIZE)
        return TEE_ERROR_BAD_PARAMETERS;
    params[1].value.a = 0;
    if (state != STATE_IDLE) return TEE_ERROR_BAD_STATE;
    const uint8_t *input = params[0].memref.buffer;
    if (TEE_MemCompare(input + 144, device_address, 20)) { params[1].value.a = 1; return TEE_ERROR_SECURITY; }
    if (TEE_MemCompare(input + 228, expected_bitstream, 32)) { params[1].value.a = 2; return TEE_ERROR_SECURITY; }
    if (TEE_MemCompare(input + 260, expected_policy, 32)) { params[1].value.a = 3; return TEE_ERROR_SECURITY; }
    if (!OSUMANIA_PROVISIONED_SRS) { params[1].value.a = 4; return TEE_ERROR_ITEM_NOT_FOUND; }
    TEE_MemMove(header, input, sizeof(header));
    state = STATE_HEADER_LOADED;
    return TEE_SUCCESS;
}

static TEE_Result finalize(uint32_t types, TEE_Param params[4])
{
    static const uint8_t domain[] = "OSUMANIA_HARDWARE_SESSION_V2";
    if (types != TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_INPUT, TEE_PARAM_TYPE_NONE,
                                 TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE) ||
        params[0].memref.size != OSUMANIA_TA_FINAL_FIELDS_SIZE)
        return TEE_ERROR_BAD_PARAMETERS;
    if (state != STATE_RECORDING) return TEE_ERROR_BAD_STATE;
    const uint8_t *fields = params[0].memref.buffer;
    if (be32_load(fields) > 50000 || be64_load(fields + 4) > 1800000000ULL) {
        state = STATE_ERROR; return TEE_ERROR_BAD_PARAMETERS;
    }
    uint8_t preimage[430], digest[32], signature[65];
    TEE_MemMove(preimage, domain, sizeof(domain) - 1);
    preimage[28] = 0; preimage[29] = 2;
    TEE_MemMove(preimage + 30, header, sizeof(header));
    TEE_MemMove(preimage + 322, fields, OSUMANIA_TA_FINAL_FIELDS_SIZE);
    TEE_Result status = sha256(preimage, sizeof(preimage), digest);
    if (status == TEE_SUCCESS) status = sign_digest(digest, signature);
    if (status != TEE_SUCCESS) {
        state = STATE_ERROR;
    } else {
        TEE_MemMove(result, header, sizeof(header));
        TEE_MemMove(result + 292, fields, OSUMANIA_TA_FINAL_FIELDS_SIZE);
        TEE_MemMove(result + 400, signature, 65);
        state = STATE_FINALIZED;
    }
    TEE_MemFill(preimage, 0, sizeof(preimage));
    TEE_MemFill(digest, 0, sizeof(digest));
    TEE_MemFill(signature, 0, sizeof(signature));
    return status;
}

TEE_Result TA_InvokeCommandEntryPoint(void *context, uint32_t command,
                                      uint32_t types, TEE_Param params[4])
{
    (void)context;
    switch (command) {
    case OSUMANIA_TA_GET_DEVICE: return get_device(types, params);
    case OSUMANIA_TA_SET_HEADER: return set_header(types, params);
    case OSUMANIA_TA_START_SESSION:
        if (state != STATE_HEADER_LOADED) return TEE_ERROR_BAD_STATE;
        state = STATE_RECORDING; return TEE_SUCCESS;
    case OSUMANIA_TA_FINALIZE_SESSION: return finalize(types, params);
    case OSUMANIA_TA_GET_RESULT:
        if (state != STATE_FINALIZED) return TEE_ERROR_BAD_STATE;
        if (types != TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_OUTPUT, TEE_PARAM_TYPE_NONE,
                                     TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE)) return TEE_ERROR_BAD_PARAMETERS;
        if (params[0].memref.size < sizeof(result)) { params[0].memref.size = sizeof(result); return TEE_ERROR_SHORT_BUFFER; }
        TEE_MemMove(params[0].memref.buffer, result, sizeof(result)); params[0].memref.size = sizeof(result); return TEE_SUCCESS;
    case OSUMANIA_TA_ABORT_SESSION:
        if (initialization_status != TEE_SUCCESS) return initialization_status;
        TEE_MemFill(header, 0, sizeof(header)); TEE_MemFill(result, 0, sizeof(result)); state = STATE_IDLE; return TEE_SUCCESS;
    case OSUMANIA_TA_GET_STATE:
        if (types != TEE_PARAM_TYPES(TEE_PARAM_TYPE_VALUE_OUTPUT, TEE_PARAM_TYPE_NONE,
                                     TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE)) return TEE_ERROR_BAD_PARAMETERS;
        params[0].value.a = state;
        params[0].value.b = initialization_status;
        return TEE_SUCCESS;
    default: return TEE_ERROR_NOT_SUPPORTED;
    }
}
