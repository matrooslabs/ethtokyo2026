#define _POSIX_C_SOURCE 200809L
#include "optee_signer.h"
#include "keccak256.h"
#include "osumania_ta.h"

#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/obj_mac.h>
#include <openssl/sha.h>

#ifdef HAVE_LIBTEEC
#include <tee_client_api.h>
#endif

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static const uint8_t input_policy_hash[32] = {
    0x1d,0xd3,0xe7,0x15,0x32,0x31,0x9b,0xcc,0xa3,0x1f,0x8f,0x24,0x8b,0xae,0x6a,0x8c,
    0x8e,0x05,0x7c,0xdd,0xbd,0x69,0x2b,0xfa,0xdf,0x3e,0xb0,0x6e,0x0a,0xe7,0x54,0x60,
};

struct dev_signer {
    EC_KEY *key;
    uint8_t header[OSUM_HEADER_SIZE];
    uint8_t result[OSUM_RESULT_SIZE];
};

struct osum_signer {
    enum { SIGNER_NONE, SIGNER_DEV, SIGNER_OPTEE } backend;
    bool ready;
    enum osum_state state;
    uint32_t last_result;
    uint32_t last_origin;
    struct osum_signer_info info;
    struct dev_signer dev;
#ifdef HAVE_LIBTEEC
    TEEC_Context context;
    TEEC_Session session;
#endif
};

static int hex_value(char ch)
{
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

static int hex_decode(const char *text, uint8_t *output, size_t length)
{
    if (!text)
        return -1;
    if (!strncmp(text, "0x", 2))
        text += 2;
    if (strlen(text) != length * 2u)
        return -1;
    for (size_t i = 0; i < length; ++i) {
        int high = hex_value(text[i * 2]);
        int low = hex_value(text[i * 2 + 1]);
        if (high < 0 || low < 0)
            return -1;
        output[i] = (uint8_t)(high << 4 | low);
    }
    return 0;
}

static int config_value(const char *name, char *value, size_t capacity)
{
    const char *environment = getenv(name);
    if (environment && strlen(environment) < capacity) {
        strcpy(value, environment);
        return 0;
    }
    FILE *file = fopen("/etc/osumania-provision.conf", "r");
    if (!file)
        return -1;
    char line[512];
    int found = -1;
    while (fgets(line, sizeof(line), file)) {
        char *equal = strchr(line, '=');
        if (!equal)
            continue;
        *equal = '\0';
        char *end = equal + 1 + strcspn(equal + 1, "\r\n");
        *end = '\0';
        if (!strcmp(line, name) && strlen(equal + 1) < capacity) {
            strcpy(value, equal + 1);
            found = 0;
            break;
        }
    }
    fclose(file);
    return found;
}

static int derive_address(EC_KEY *key, uint8_t address[20])
{
    const EC_GROUP *group = EC_KEY_get0_group(key);
    const EC_POINT *point = EC_KEY_get0_public_key(key);
    BN_CTX *ctx = BN_CTX_new();
    BIGNUM *x = BN_new(), *y = BN_new();
    uint8_t pub[64], hash[32];
    int ok = ctx && x && y && point &&
        EC_POINT_get_affine_coordinates(group, point, x, y, ctx) == 1 &&
        BN_bn2binpad(x, pub, 32) == 32 && BN_bn2binpad(y, pub + 32, 32) == 32;
    if (ok) {
        osum_keccak256(pub, sizeof(pub), hash);
        memcpy(address, hash + 12, 20);
    }
    OPENSSL_cleanse(pub, sizeof(pub));
    OPENSSL_cleanse(hash, sizeof(hash));
    BN_clear_free(x); BN_clear_free(y); BN_CTX_free(ctx);
    return ok ? 0 : -1;
}

static int recover_matches(const EC_GROUP *group, const EC_POINT *wanted,
                           const BIGNUM *r, const BIGNUM *s,
                           const uint8_t digest[32], int parity)
{
    BN_CTX *ctx = BN_CTX_new();
    BIGNUM *order = BN_new(), *field = BN_new(), *x = BN_dup(r);
    BIGNUM *e = BN_bin2bn(digest, 32, NULL), *rinv = NULL;
    EC_POINT *R = EC_POINT_new(group), *Q = EC_POINT_new(group), *eG = EC_POINT_new(group);
    int match = 0;
    if (!ctx || !order || !field || !x || !e || !R || !Q || !eG ||
        EC_GROUP_get_order(group, order, ctx) != 1 ||
        EC_GROUP_get_curve(group, field, NULL, NULL, ctx) != 1 ||
        BN_mod(e, e, order, ctx) != 1 ||
        EC_POINT_set_compressed_coordinates(group, R, x, parity, ctx) != 1)
        goto out;
    EC_POINT *check = EC_POINT_new(group);
    if (!check || EC_POINT_mul(group, check, NULL, R, order, ctx) != 1 ||
        !EC_POINT_is_at_infinity(group, check)) {
        EC_POINT_free(check);
        goto out;
    }
    EC_POINT_free(check);
    if (EC_POINT_mul(group, Q, NULL, R, s, ctx) != 1 ||
        EC_POINT_mul(group, eG, e, NULL, NULL, ctx) != 1 ||
        EC_POINT_invert(group, eG, ctx) != 1 ||
        EC_POINT_add(group, Q, Q, eG, ctx) != 1)
        goto out;
    rinv = BN_mod_inverse(NULL, r, order, ctx);
    if (!rinv || EC_POINT_mul(group, Q, NULL, Q, rinv, ctx) != 1)
        goto out;
    match = EC_POINT_cmp(group, Q, wanted, ctx) == 0;
out:
    BN_clear_free(order); BN_clear_free(field); BN_clear_free(x); BN_clear_free(e);
    BN_clear_free(rinv); EC_POINT_free(R); EC_POINT_free(Q); EC_POINT_free(eG); BN_CTX_free(ctx);
    return match;
}

static int dev_sign(struct dev_signer *dev, const uint8_t digest[32], uint8_t signature[65])
{
    const EC_GROUP *group = EC_KEY_get0_group(dev->key);
    const EC_POINT *public_key = EC_KEY_get0_public_key(dev->key);
    BN_CTX *ctx = BN_CTX_new();
    BIGNUM *order = BN_new(), *half = BN_new();
    if (!ctx || !order || !half || EC_GROUP_get_order(group, order, ctx) != 1 ||
        !BN_rshift1(half, order)) {
        BN_CTX_free(ctx); BN_free(order); BN_free(half);
        return -1;
    }
    int result = -1;
    for (int attempt = 0; attempt < 16 && result; ++attempt) {
        ECDSA_SIG *raw = ECDSA_do_sign(digest, 32, dev->key);
        if (!raw)
            continue;
        const BIGNUM *raw_r, *raw_s;
        ECDSA_SIG_get0(raw, &raw_r, &raw_s);
        BIGNUM *r = BN_dup(raw_r), *s = BN_dup(raw_s);
        if (r && s && BN_cmp(s, half) > 0)
            BN_sub(s, order, s);
        if (r && s && BN_bn2binpad(r, signature, 32) == 32 &&
            BN_bn2binpad(s, signature + 32, 32) == 32) {
            for (int parity = 0; parity < 2; ++parity) {
                if (recover_matches(group, public_key, r, s, digest, parity)) {
                    signature[64] = (uint8_t)(27 + parity);
                    result = 0;
                    break;
                }
            }
        }
        BN_clear_free(r); BN_clear_free(s); ECDSA_SIG_free(raw);
    }
    BN_clear_free(order); BN_clear_free(half); BN_CTX_free(ctx);
    return result;
}

static int dev_open(struct osum_signer *signer)
{
    char key_hex[128], bitstream_hex[128];
    if (config_value("DEV_INSECURE_PRIVATE_KEY", key_hex, sizeof(key_hex)) != 0 ||
        config_value("OSUMANIA_BITSTREAM_HASH", bitstream_hex, sizeof(bitstream_hex)) != 0)
        return -1;
    uint8_t key_bytes[32];
    if (hex_decode(key_hex, key_bytes, sizeof(key_bytes)) != 0 ||
        hex_decode(bitstream_hex, signer->info.bitstream_hash, 32) != 0)
        return -1;
    fprintf(stderr, "WARNING: DEV_INSECURE_KEY_BACKEND active; key is not protected by OP-TEE\n");
    EC_KEY *key = EC_KEY_new_by_curve_name(NID_secp256k1);
    BIGNUM *private_key = BN_bin2bn(key_bytes, 32, NULL);
    const EC_GROUP *group = key ? EC_KEY_get0_group(key) : NULL;
    EC_POINT *public_key = group ? EC_POINT_new(group) : NULL;
    int ok = key && private_key && public_key && !BN_is_zero(private_key) &&
        BN_cmp(private_key, EC_GROUP_get0_order(group)) < 0 &&
        EC_POINT_mul(group, public_key, private_key, NULL, NULL, NULL) == 1 &&
        EC_KEY_set_private_key(key, private_key) == 1 &&
        EC_KEY_set_public_key(key, public_key) == 1;
    OPENSSL_cleanse(key_bytes, sizeof(key_bytes));
    BN_clear_free(private_key); EC_POINT_free(public_key);
    if (!ok || derive_address(key, signer->info.device) != 0) {
        EC_KEY_free(key);
        return -1;
    }
    signer->dev.key = key;
    signer->backend = SIGNER_DEV;
    signer->state = OSUM_STATE_IDLE;
    signer->ready = true;
    return 0;
}

#ifdef HAVE_LIBTEEC
static int invoke(struct osum_signer *signer, uint32_t command, TEEC_Operation *operation)
{
    uint32_t origin = 0;
    TEEC_Result result = TEEC_InvokeCommand(&signer->session, command, operation, &origin);
    signer->last_result = result;
    signer->last_origin = origin;
    if (result != TEEC_SUCCESS) {
        fprintf(stderr, "OP-TEE invoke command=%u failed result=0x%08x origin=%u\n",
                command, result, origin);
        return -1;
    }
    return 0;
}

static int optee_open(struct osum_signer *signer)
{
    const TEEC_UUID uuid = OSUMANIA_TA_UUID;
    uint32_t origin = 0;
    TEEC_Result result = TEEC_InitializeContext(NULL, &signer->context);
    signer->last_result = result;
    signer->last_origin = 0;
    if (result != TEEC_SUCCESS) {
        fprintf(stderr, "OP-TEE InitializeContext failed result=0x%08x\n", result);
        return -1;
    }
    for (unsigned attempt = 1; attempt <= 50; ++attempt) {
        origin = 0;
        result = TEEC_OpenSession(&signer->context, &signer->session, &uuid,
                                  TEEC_LOGIN_PUBLIC, NULL, NULL, &origin);
        signer->last_result = result;
        signer->last_origin = origin;
        if (result == TEEC_SUCCESS)
            break;
        if (result == TEEC_ERROR_SECURITY || result == TEEC_ERROR_ACCESS_DENIED ||
            result == TEEC_ERROR_BAD_FORMAT)
            break;
        if (attempt != 50) {
            const struct timespec retry_delay = { .tv_nsec = 100000000L };
            nanosleep(&retry_delay, NULL);
        }
    }
    if (result != TEEC_SUCCESS) {
        fprintf(stderr, "OP-TEE OpenSession failed result=0x%08x origin=%u\n",
                result, origin);
        TEEC_FinalizeContext(&signer->context);
        return -1;
    }
    signer->backend = SIGNER_OPTEE;
    TEEC_Operation state_op = { .paramTypes = TEEC_PARAM_TYPES(TEEC_VALUE_OUTPUT, TEEC_NONE, TEEC_NONE, TEEC_NONE) };
    if (invoke(signer, OSUMANIA_TA_GET_STATE, &state_op) != 0)
        return -1;
    if (state_op.params[0].value.b != TEEC_SUCCESS) {
        signer->last_result = state_op.params[0].value.b;
        signer->last_origin = TEEC_ORIGIN_TRUSTED_APP;
        fprintf(stderr, "OP-TEE TA initialization failed result=0x%08x\n",
                signer->last_result);
        return -1;
    }
    signer->state = (enum osum_state)state_op.params[0].value.a;
    if (signer->state == OSUM_STATE_HEADER_LOADED || signer->state == OSUM_STATE_RECORDING ||
        signer->state == OSUM_STATE_FINALIZED || signer->state == OSUM_STATE_ERROR) {
        TEEC_Operation abort_op = {0};
        if (invoke(signer, OSUMANIA_TA_ABORT_SESSION, &abort_op) != 0)
            return -1;
        signer->state = OSUM_STATE_IDLE;
    }
    signer->ready = true;
    signer->last_result = TEEC_SUCCESS;
    signer->last_origin = 0;
    fprintf(stderr, "OP-TEE signer ready\n");
    return 0;
}
#endif

struct osum_signer *osum_signer_open(const char *backend)
{
    struct osum_signer *signer = calloc(1, sizeof(*signer));
    if (!signer)
        return NULL;
    if (backend && !strcmp(backend, "dev-insecure")) {
        if (dev_open(signer) != 0)
            signer->ready = false;
    } else {
#ifdef HAVE_LIBTEEC
        if (optee_open(signer) != 0) {
            fprintf(stderr, "OP-TEE signer unavailable; keyboard forwarding remains active\n");
            signer->ready = false;
        }
#else
        fprintf(stderr, "OP-TEE client support unavailable; keyboard forwarding remains active\n");
        signer->ready = false;
#endif
    }
    return signer;
}

void osum_signer_close(struct osum_signer *signer)
{
    if (!signer) return;
    EC_KEY_free(signer->dev.key);
#ifdef HAVE_LIBTEEC
    if (signer->backend == SIGNER_OPTEE) {
        TEEC_CloseSession(&signer->session);
        TEEC_FinalizeContext(&signer->context);
    }
#endif
    OPENSSL_cleanse(signer, sizeof(*signer));
    free(signer);
}

bool osum_signer_ready(const struct osum_signer *signer) { return signer && signer->ready; }
bool osum_signer_is_insecure(const struct osum_signer *signer) { return signer && signer->backend == SIGNER_DEV; }
enum osum_state osum_signer_state(const struct osum_signer *signer) { return signer ? signer->state : OSUM_STATE_ERROR; }
void osum_signer_failure(const struct osum_signer *signer, uint32_t *result,
                         uint32_t *origin)
{
    if (result) *result = signer ? signer->last_result : 0;
    if (origin) *origin = signer ? signer->last_origin : 0;
}

int osum_signer_get_info(struct osum_signer *signer, struct osum_signer_info *info)
{
    if (!osum_signer_ready(signer)) return -1;
    if (signer->backend == SIGNER_DEV) { *info = signer->info; return 0; }
#ifdef HAVE_LIBTEEC
    TEEC_Operation op = { .paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_OUTPUT, TEEC_NONE, TEEC_NONE, TEEC_NONE) };
    uint8_t data[OSUMANIA_TA_DEVICE_INFO_SIZE];
    op.params[0].tmpref.buffer = data; op.params[0].tmpref.size = sizeof(data);
    if (invoke(signer, OSUMANIA_TA_GET_DEVICE, &op) != 0 || op.params[0].tmpref.size != sizeof(data)) return -1;
    memcpy(info->device, data, 20); memcpy(info->bitstream_hash, data + 20, 32); return 0;
#else
    return -1;
#endif
}

int osum_signer_set_header(struct osum_signer *signer, const uint8_t header[OSUM_HEADER_SIZE], uint8_t *detail)
{
    *detail = 0;
    if (!osum_signer_ready(signer) || signer->state != OSUM_STATE_IDLE) return -1;
    if (signer->backend == SIGNER_DEV) {
        if (memcmp(header + 144, signer->info.device, 20)) { *detail = OSUM_HEADER_DEVICE; return -1; }
        if (memcmp(header + 228, signer->info.bitstream_hash, 32)) { *detail = OSUM_HEADER_BITSTREAM; return -1; }
        if (memcmp(header + 260, input_policy_hash, 32)) { *detail = OSUM_HEADER_POLICY; return -1; }
        memcpy(signer->dev.header, header, OSUM_HEADER_SIZE);
        signer->state = OSUM_STATE_HEADER_LOADED;
        return 0;
    }
#ifdef HAVE_LIBTEEC
    TEEC_Operation op = { .paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT, TEEC_VALUE_OUTPUT, TEEC_NONE, TEEC_NONE) };
    op.params[0].tmpref.buffer = (void *)header; op.params[0].tmpref.size = OSUM_HEADER_SIZE;
    int status = invoke(signer, OSUMANIA_TA_SET_HEADER, &op);
    *detail = (uint8_t)op.params[1].value.a;
    if (!status)
        signer->state = OSUM_STATE_HEADER_LOADED;
    return status;
#else
    return -1;
#endif
}

int osum_signer_start(struct osum_signer *signer)
{
    if (!osum_signer_ready(signer) || signer->state != OSUM_STATE_HEADER_LOADED) return -1;
    if (signer->backend == SIGNER_DEV) { signer->state = OSUM_STATE_RECORDING; return 0; }
#ifdef HAVE_LIBTEEC
    TEEC_Operation op = {0};
    int status = invoke(signer, OSUMANIA_TA_START_SESSION, &op);
    if (!status)
        signer->state = OSUM_STATE_RECORDING;
    return status;
#else
    return -1;
#endif
}

int osum_signer_finalize(struct osum_signer *signer, uint32_t count, uint64_t duration_us,
                         const uint8_t root[32], const uint8_t commitment[64])
{
    if (!osum_signer_ready(signer) || signer->state != OSUM_STATE_RECORDING) return -1;
    uint8_t fields[OSUMANIA_TA_FINAL_FIELDS_SIZE];
    osum_be32_store(fields, count); osum_be64_store(fields + 4, duration_us);
    memcpy(fields + 12, root, 32); memcpy(fields + 44, commitment, 64);
    if (signer->backend == SIGNER_DEV) {
        static const uint8_t domain[] = "OSUMANIA_HARDWARE_SESSION_V2";
        uint8_t preimage[430], digest[32], signature[65];
        memcpy(preimage, domain, sizeof(domain) - 1); preimage[28] = 0; preimage[29] = 2;
        memcpy(preimage + 30, signer->dev.header, OSUM_HEADER_SIZE);
        memcpy(preimage + 322, fields, sizeof(fields));
        SHA256(preimage, sizeof(preimage), digest);
        if (dev_sign(&signer->dev, digest, signature) != 0) { signer->state = OSUM_STATE_ERROR; return -1; }
        memcpy(signer->dev.result, signer->dev.header, OSUM_HEADER_SIZE);
        memcpy(signer->dev.result + OSUM_HEADER_SIZE, fields, sizeof(fields));
        memcpy(signer->dev.result + 400, signature, 65);
        OPENSSL_cleanse(preimage, sizeof(preimage)); OPENSSL_cleanse(digest, sizeof(digest));
        signer->state = OSUM_STATE_FINALIZED; return 0;
    }
#ifdef HAVE_LIBTEEC
    TEEC_Operation op = { .paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT, TEEC_NONE, TEEC_NONE, TEEC_NONE) };
    op.params[0].tmpref.buffer = fields; op.params[0].tmpref.size = sizeof(fields);
    int status = invoke(signer, OSUMANIA_TA_FINALIZE_SESSION, &op);
    if (!status) signer->state = OSUM_STATE_FINALIZED; else signer->state = OSUM_STATE_ERROR;
    return status;
#else
    signer->state = OSUM_STATE_ERROR; return -1;
#endif
}

int osum_signer_get_result(struct osum_signer *signer, uint8_t result[OSUM_RESULT_SIZE])
{
    if (!osum_signer_ready(signer) || signer->state != OSUM_STATE_FINALIZED) return -1;
    if (signer->backend == SIGNER_DEV) { memcpy(result, signer->dev.result, OSUM_RESULT_SIZE); return 0; }
#ifdef HAVE_LIBTEEC
    TEEC_Operation op = { .paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_OUTPUT, TEEC_NONE, TEEC_NONE, TEEC_NONE) };
    op.params[0].tmpref.buffer = result; op.params[0].tmpref.size = OSUM_RESULT_SIZE;
    return invoke(signer, OSUMANIA_TA_GET_RESULT, &op);
#else
    return -1;
#endif
}

int osum_signer_abort(struct osum_signer *signer)
{
    if (!signer) return -1;
    int status = 0;
#ifdef HAVE_LIBTEEC
    if (signer->backend == SIGNER_OPTEE) { TEEC_Operation op = {0}; status = invoke(signer, OSUMANIA_TA_ABORT_SESSION, &op); }
#endif
    if (!status) {
        OPENSSL_cleanse(signer->dev.header, sizeof(signer->dev.header));
        OPENSSL_cleanse(signer->dev.result, sizeof(signer->dev.result));
        signer->state = OSUM_STATE_IDLE;
    }
    return status;
}
