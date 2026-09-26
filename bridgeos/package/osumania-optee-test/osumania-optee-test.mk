################################################################################
# osu!mania OP-TEE QEMU integration test client
################################################################################
OSUMANIA_OPTEE_TEST_VERSION = 1.0
OSUMANIA_OPTEE_TEST_SITE = $(BR2_EXTERNAL_RADXA_ZERO3_RT_PATH)/package/osumania-optee-test
OSUMANIA_OPTEE_TEST_SITE_METHOD = local
OSUMANIA_OPTEE_TEST_DEPENDENCIES = optee-client openssl
OSUMANIA_OPTEE_TEST_LICENSE = MIT

define OSUMANIA_OPTEE_TEST_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) -Wall -Wextra -Wno-deprecated-declarations \
		-I$(BR2_EXTERNAL_RADXA_ZERO3_RT_PATH)/optee/osumania_signer/include \
		-I$(BR2_EXTERNAL_RADXA_ZERO3_RT_PATH)/package/bridge-daemon \
		-o $(@D)/osumania-optee-test $(@D)/osumania-optee-test.c \
		$(BR2_EXTERNAL_RADXA_ZERO3_RT_PATH)/package/bridge-daemon/keccak256.c \
		$(TARGET_LDFLAGS) -lteec -lcrypto
endef

define OSUMANIA_OPTEE_TEST_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/osumania-optee-test $(TARGET_DIR)/usr/bin/osumania-optee-test
endef

$(eval $(generic-package))
