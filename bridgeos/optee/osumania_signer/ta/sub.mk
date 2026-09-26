global-incdirs-y += . ../include third_party/micro-ecc
srcs-y += osumania_signer_ta.c
srcs-y += keccak256.c
srcs-y += third_party/micro-ecc/uECC.c

cppflags-y += -DuECC_NO_DEFAULT_RNG=1
cppflags-y += -DuECC_SUPPORTS_secp160r1=0 -DuECC_SUPPORTS_secp192r1=0
cppflags-y += -DuECC_SUPPORTS_secp224r1=0 -DuECC_SUPPORTS_secp256r1=0
cppflags-y += -DuECC_SUPPORT_COMPRESSED_POINT=0
ifeq ($(CFG_OSUMANIA_DEV_INSECURE_KEY),y)
srcs-y += device_root_dev.c
cppflags-y += -DOSUMANIA_PROVISIONED_SRS=1
else
srcs-y += device_root_rk3566.c
# Production integration must provide both of these from reviewed provisioning.
cppflags-y += -DOSUMANIA_PROVISIONED_SRS=0
endif
