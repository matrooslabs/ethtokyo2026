/* Execute the actual MVP TA with host SHA-256 shims and real micro-ecc signing.
 * Test keys and bank identity are fixed, public, and never used on a device. */
#define CFG_OSUMANIA_MVP_KEYED 1
#define OSUMANIA_PROVISIONED_SRS 1
#define OSUMANIA_PROVISIONED_SRS_POINTS 200000
#define TEST_KEY_BYTES { [0 ... 31] = 0x11 }
#define OSUMANIA_MVP_PRIVATE_KEY_BYTES TEST_KEY_BYTES
#define OSUMANIA_PROVISIONED_BITSTREAM_HASH { [0 ... 31] = 0x44 }
#define OSUMANIA_PROVISIONED_SRS_HASH { [0 ... 31] = 0x55 }

#include "tee_internal_api.h"
#include <openssl/sha.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

struct test_digest { SHA256_CTX sha; };
TEE_Result TEE_AllocateOperation(TEE_OperationHandle *out, uint32_t algorithm, uint32_t mode, uint32_t size)
{
    (void)size;
    if (algorithm != TEE_ALG_SHA256 || mode != TEE_MODE_DIGEST) return TEE_ERROR_NOT_SUPPORTED;
    *out = malloc(sizeof(**out));
    if (!*out) return TEE_ERROR_BAD_STATE;
    SHA256_Init(&(*out)->sha);
    return TEE_SUCCESS;
}
void TEE_ResetOperation(TEE_OperationHandle op) { SHA256_Init(&op->sha); }
void TEE_DigestUpdate(TEE_OperationHandle op, const void *data, size_t len) { SHA256_Update(&op->sha, data, len); }
TEE_Result TEE_DigestDoFinal(TEE_OperationHandle op, const void *data, size_t len, void *digest, size_t *out_len)
{
    if (*out_len < 32) return TEE_ERROR_SHORT_BUFFER;
    if (len) SHA256_Update(&op->sha, data, len);
    SHA256_Final(digest, &op->sha);
    *out_len = 32;
    return TEE_SUCCESS;
}
void TEE_FreeOperation(TEE_OperationHandle op) { free(op); }

#include "../../optee/osumania_signer/ta/osumania_signer_ta.c"

static void root_for_trace(const uint8_t sid[32], uint8_t out[32])
{
    uint8_t seed[sizeof("OSUMANIA_TRACE_V1") - 1 + 32];
    memcpy(seed, "OSUMANIA_TRACE_V1", sizeof(seed) - 32);
    memcpy(seed + sizeof(seed) - 32, sid, 32);
    SHA256(seed, sizeof(seed), out);
    for (unsigned chunk = 0; chunk < 2; ++chunk) {
        const unsigned count = chunk == 0 ? 32 : 1;
        uint8_t data[32 + 4 + 2 + 32 * 14];
        memcpy(data, out, 32);
        be32_store(data + 32, chunk);
        data[36] = 0; data[37] = (uint8_t)count;
        for (unsigned j = 0; j < count; ++j) {
            unsigned i = chunk * 32 + j;
            uint8_t *event = data + 38 + j * 14;
            be32_store(event, i);
            memset(event + 4, 0, 8);
            be32_store(event + 8, (i + 1) * 1000);
            event[12] = i % 4;
            event[13] = (i / 4) % 2;
        }
        SHA256(data, 38 + count * 14, out);
    }
}

int main(void)
{
    assert(TA_CreateEntryPoint() == TEE_SUCCESS);
    TEE_Param args[4] = {0};
    uint8_t device[OSUMANIA_TA_DEVICE_INFO_SIZE];
    args[0].memref.buffer = device; args[0].memref.size = sizeof(device);
    assert(TA_InvokeCommandEntryPoint(NULL, OSUMANIA_TA_GET_DEVICE,
        TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_OUTPUT, 0, 0, 0), args) == TEE_SUCCESS);
    assert(device[84] == 0 && device[85] == 0 && device[86] == 0xc3 && device[87] == 0x50);
    uint8_t session_header[OSUMANIA_TA_HEADER_SIZE] = {0};
    memset(session_header + 60, 0x32, 32);
    memcpy(session_header + 144, device, 20);
    memcpy(session_header + 228, device + 20, 32);
    memcpy(session_header + 260, expected_policy, 32);
    args[0].memref.buffer = session_header; args[0].memref.size = sizeof(session_header);
    assert(TA_InvokeCommandEntryPoint(NULL, OSUMANIA_TA_SET_HEADER,
        TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_INPUT, TEE_PARAM_TYPE_VALUE_OUTPUT, 0, 0), args) == TEE_SUCCESS);
    assert(TA_InvokeCommandEntryPoint(NULL, OSUMANIA_TA_START_SESSION, 0, args) == TEE_SUCCESS);

    uint8_t fields[OSUMANIA_TA_FINAL_FIELDS_SIZE] = {0};
    be32_store(fields, 33);
    fields[4] = 0; fields[5] = 0; fields[6] = 0; fields[7] = 0;
    be32_store(fields + 8, 5000000);
    root_for_trace(session_header + 60, fields + 12);
    static const uint8_t generator[48] = {
        0x97,0xf1,0xd3,0xa7,0x31,0x97,0xd7,0x94,0x26,0x95,0x63,0x8c,
        0x4f,0xa9,0xac,0x0f,0xc3,0x68,0x8c,0x4f,0x97,0x74,0xb9,0x05,
        0xa1,0x4e,0x3a,0x3f,0x17,0x1b,0xac,0x58,0x6c,0x55,0xe8,0x3f,
        0xf9,0x7a,0x1a,0xef,0xfb,0x3a,0xf0,0x0a,0xdb,0x22,0xc6,0xbb,
    };
    memcpy(fields + 44, generator, sizeof(generator));
    args[0].memref.buffer = fields; args[0].memref.size = sizeof(fields);
    assert(TA_InvokeCommandEntryPoint(NULL, OSUMANIA_TA_FINALIZE_SESSION,
        TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_INPUT, 0, 0, 0), args) == TEE_SUCCESS);
    uint8_t sealed[OSUMANIA_TA_RESULT_SIZE];
    memset(sealed, 0xa5, sizeof(sealed));
    args[0].memref.buffer = sealed; args[0].memref.size = sizeof(sealed);
    assert(TA_InvokeCommandEntryPoint(NULL, OSUMANIA_TA_GET_RESULT,
        TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_OUTPUT, 0, 0, 0), args) == TEE_SUCCESS);
    assert(args[0].memref.size == sizeof(sealed));
    assert(memcmp(sealed, session_header, sizeof(session_header)) == 0);
    assert(memcmp(sealed + sizeof(session_header), fields, sizeof(fields)) == 0);
    assert(sealed[448] == 27 || sealed[448] == 28);

    static const uint8_t domain[] = "OSUMANIA_HARDWARE_SESSION_V2_BLS12381";
    uint8_t preimage[sizeof(domain) - 1 + 2 + sizeof(session_header) + sizeof(fields)];
    uint8_t digest[32], public_key[64];
    memcpy(preimage, domain, sizeof(domain) - 1);
    preimage[sizeof(domain) - 1] = 0; preimage[sizeof(domain)] = 2;
    memcpy(preimage + sizeof(domain) + 1, session_header, sizeof(session_header));
    memcpy(preimage + sizeof(domain) + 1 + sizeof(session_header), fields, sizeof(fields));
    SHA256(preimage, sizeof(preimage), digest);
    const uint8_t key[32] = TEST_KEY_BYTES;
    assert(uECC_compute_public_key(key, public_key, uECC_secp256k1()));
    assert(uECC_verify(public_key, digest, 32, sealed + 384, uECC_secp256k1()));
    TA_DestroyEntryPoint();
    puts("PASS actual TA: 33-event root, original footer, 384-byte signature offset and signed Mode B digest");
    return 0;
}
