#include <tee_client_api.h>
#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/obj_mac.h>
#include <openssl/sha.h>

#include "osumania_ta.h"
#include "keccak256.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void be32(uint8_t out[4], uint32_t v) { out[0]=v>>24; out[1]=v>>16; out[2]=v>>8; out[3]=v; }
static void be64(uint8_t out[8], uint64_t v) { be32(out,v>>32); be32(out+4,v); }

static int recover_address(const uint8_t digest[32], const uint8_t signature[65], uint8_t address[20])
{
    if (signature[64] != 27 && signature[64] != 28) return -1;
    int parity = signature[64] - 27, result = -1;
    EC_GROUP *group=EC_GROUP_new_by_curve_name(NID_secp256k1); BN_CTX *ctx=BN_CTX_new();
    BIGNUM *r=BN_bin2bn(signature,32,NULL), *s=BN_bin2bn(signature+32,32,NULL), *e=BN_bin2bn(digest,32,NULL);
    BIGNUM *order=BN_new(), *rinv=NULL, *half=BN_new(), *x=BN_dup(r), *y=BN_new();
    EC_POINT *R=EC_POINT_new(group), *Q=EC_POINT_new(group), *eG=EC_POINT_new(group), *check=EC_POINT_new(group);
    if (!group||!ctx||!r||!s||!e||!order||!half||!x||!y||!R||!Q||!eG||!check ||
        EC_GROUP_get_order(group,order,ctx)!=1 || !BN_rshift1(half,order) || BN_cmp(s,half)>0 ||
        !BN_mod(e,e,order,ctx) || EC_POINT_set_compressed_coordinates(group,R,x,parity,ctx)!=1 ||
        EC_POINT_mul(group,check,NULL,R,order,ctx)!=1 || !EC_POINT_is_at_infinity(group,check) ||
        EC_POINT_mul(group,Q,NULL,R,s,ctx)!=1 || EC_POINT_mul(group,eG,e,NULL,NULL,ctx)!=1 ||
        EC_POINT_invert(group,eG,ctx)!=1 || EC_POINT_add(group,Q,Q,eG,ctx)!=1)
        goto out;
    rinv=BN_mod_inverse(NULL,r,order,ctx);
    if (!rinv || EC_POINT_mul(group,Q,NULL,Q,rinv,ctx)!=1 ||
        EC_POINT_get_affine_coordinates(group,Q,x,y,ctx)!=1) goto out;
    uint8_t pub[64], hash[32];
    if (BN_bn2binpad(x,pub,32)!=32 || BN_bn2binpad(y,pub+32,32)!=32) goto out;
    osum_keccak256(pub,64,hash); memcpy(address,hash+12,20); result=0;
out:
    BN_clear_free(r);BN_clear_free(s);BN_clear_free(e);BN_clear_free(order);BN_clear_free(rinv);BN_clear_free(half);BN_clear_free(x);BN_clear_free(y);
    EC_POINT_free(R);EC_POINT_free(Q);EC_POINT_free(eG);EC_POINT_free(check);EC_GROUP_free(group);BN_CTX_free(ctx); return result;
}

static int invoke(TEEC_Session *session, uint32_t command, TEEC_Operation *operation)
{
    uint32_t origin; TEEC_Result result=TEEC_InvokeCommand(session,command,operation,&origin);
    if (result != TEEC_SUCCESS) fprintf(stderr,"command %u failed 0x%x origin %u\n",command,result,origin);
    return result==TEEC_SUCCESS?0:-1;
}

int main(void)
{
    const TEEC_UUID uuid=OSUMANIA_TA_UUID; TEEC_Context context; TEEC_Session session; uint32_t origin=0;
    TEEC_Result status=TEEC_InitializeContext(NULL,&context);
    if(status!=TEEC_SUCCESS){fprintf(stderr,"TEEC_InitializeContext failed result=0x%08x\n",status);return 1;}
    fprintf(stderr,"TEEC_InitializeContext ok\n");
    status=TEEC_OpenSession(&context,&session,&uuid,TEEC_LOGIN_PUBLIC,NULL,NULL,&origin);
    if(status!=TEEC_SUCCESS){fprintf(stderr,"TEEC_OpenSession failed result=0x%08x origin=%u\n",status,origin);TEEC_FinalizeContext(&context);return 1;}
    fprintf(stderr,"TEEC_OpenSession ok\n");
    uint8_t device_info[52]; TEEC_Operation get={.paramTypes=TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_OUTPUT,TEEC_NONE,TEEC_NONE,TEEC_NONE)};
    get.params[0].tmpref.buffer=device_info; get.params[0].tmpref.size=sizeof(device_info);
    if (invoke(&session,OSUMANIA_TA_GET_DEVICE,&get)) return 2;
    uint8_t header[292]={0}; memcpy(header+60,"0123456789abcdef0123456789abcdef",32); memcpy(header+144,device_info,20); memcpy(header+228,device_info+20,32);
    const uint8_t policy[32]={0x1d,0xd3,0xe7,0x15,0x32,0x31,0x9b,0xcc,0xa3,0x1f,0x8f,0x24,0x8b,0xae,0x6a,0x8c,0x8e,0x05,0x7c,0xdd,0xbd,0x69,0x2b,0xfa,0xdf,0x3e,0xb0,0x6e,0x0a,0xe7,0x54,0x60}; memcpy(header+260,policy,32);
    TEEC_Operation set={.paramTypes=TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT,TEEC_VALUE_OUTPUT,TEEC_NONE,TEEC_NONE)}; set.params[0].tmpref.buffer=header; set.params[0].tmpref.size=292;
    if (invoke(&session,OSUMANIA_TA_SET_HEADER,&set)) return 3;
    TEEC_Operation empty={0}; if (invoke(&session,OSUMANIA_TA_START_SESSION,&empty)) return 4;
    uint8_t fields[108]={0}; be32(fields,0); be64(fields+4,42); fields[12]=1;
    TEEC_Operation finish={.paramTypes=TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT,TEEC_NONE,TEEC_NONE,TEEC_NONE)}; finish.params[0].tmpref.buffer=fields; finish.params[0].tmpref.size=sizeof(fields);
    if (invoke(&session,OSUMANIA_TA_FINALIZE_SESSION,&finish)) return 5;
    uint8_t result1[465],result2[465]; TEEC_Operation result={.paramTypes=TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_OUTPUT,TEEC_NONE,TEEC_NONE,TEEC_NONE)};
    result.params[0].tmpref.buffer=result1;result.params[0].tmpref.size=465;if(invoke(&session,OSUMANIA_TA_GET_RESULT,&result))return 6;
    result.params[0].tmpref.buffer=result2;result.params[0].tmpref.size=465;if(invoke(&session,OSUMANIA_TA_GET_RESULT,&result)||memcmp(result1,result2,465))return 7;
    uint8_t preimage[430],digest[32],recovered[20]; memcpy(preimage,"OSUMANIA_HARDWARE_SESSION_V2",28);preimage[28]=0;preimage[29]=2;memcpy(preimage+30,header,292);memcpy(preimage+322,fields,108);SHA256(preimage,430,digest);
    if (memcmp(result1,header,292)||recover_address(digest,result1+400,recovered)||memcmp(recovered,device_info,20))return 8;
    if(invoke(&session,OSUMANIA_TA_ABORT_SESSION,&empty))return 9;
    puts("PASS OP-TEE stateful 430-byte preimage, low-s recoverable signature, immutable 465-byte result");
    TEEC_CloseSession(&session);TEEC_FinalizeContext(&context);return 0;
}
