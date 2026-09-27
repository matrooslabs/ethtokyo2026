#ifndef TEST_TEE_INTERNAL_API_H
#define TEST_TEE_INTERNAL_API_H
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef uint32_t TEE_Result;
struct test_digest;
typedef struct test_digest *TEE_OperationHandle;
#define TEE_HANDLE_NULL NULL
#define TEE_SUCCESS 0u
#define TEE_ERROR_BAD_FORMAT 0xffff0005u
#define TEE_ERROR_BAD_PARAMETERS 0xffff0006u
#define TEE_ERROR_BAD_STATE 0xffff0007u
#define TEE_ERROR_ITEM_NOT_FOUND 0xffff0008u
#define TEE_ERROR_SECURITY 0xffff000fu
#define TEE_ERROR_SHORT_BUFFER 0xffff0010u
#define TEE_ERROR_NOT_SUPPORTED 0xffff000au
#define TEE_ALG_SHA256 1u
#define TEE_MODE_DIGEST 2u
#define TEE_PARAM_TYPE_NONE 0u
#define TEE_PARAM_TYPE_VALUE_OUTPUT 1u
#define TEE_PARAM_TYPE_MEMREF_INPUT 2u
#define TEE_PARAM_TYPE_MEMREF_OUTPUT 3u
#define TEE_PARAM_TYPES(a, b, c, d) ((a) | ((b) << 4) | ((c) << 8) | ((d) << 12))

typedef struct {
    struct { void *buffer; size_t size; } memref;
    struct { uint32_t a, b; } value;
} TEE_Param;
#define TEE_MemFill memset
#define TEE_MemMove memmove
#define TEE_MemCompare memcmp
TEE_Result TEE_AllocateOperation(TEE_OperationHandle *out, uint32_t algorithm, uint32_t mode, uint32_t max_key_size);
TEE_Result TEE_DigestDoFinal(TEE_OperationHandle operation, const void *data, size_t length,
                             void *digest, size_t *digest_length);
void TEE_DigestUpdate(TEE_OperationHandle operation, const void *data, size_t length);
void TEE_ResetOperation(TEE_OperationHandle operation);
void TEE_FreeOperation(TEE_OperationHandle operation);
#endif
