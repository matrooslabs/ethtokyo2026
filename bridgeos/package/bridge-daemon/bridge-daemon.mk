################################################################################
#
# bridge-daemon
#
################################################################################

BRIDGE_DAEMON_VERSION = 1.0
BRIDGE_DAEMON_SITE = $(BR2_EXTERNAL_RADXA_ZERO3_RT_PATH)/package/bridge-daemon
BRIDGE_DAEMON_SITE_METHOD = local
BRIDGE_DAEMON_LICENSE = MIT
BRIDGE_DAEMON_LICENSE_FILES = LICENSE
BRIDGE_DAEMON_DEPENDENCIES = openssl optee-client

define BRIDGE_DAEMON_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) -std=c11 -Wall -Wextra -Wno-deprecated-declarations -O2 \
		-DHAVE_LIBTEEC -I$(STAGING_DIR)/usr/include \
		-o $(@D)/bridge-daemon \
		$(@D)/bridge-daemon.c $(@D)/osumania_protocol.c $(@D)/osumania_crypto.c \
		$(@D)/osumania_session.c $(@D)/osumania_vendor.c \
		$(@D)/optee_signer.c $(@D)/keccak256.c \
		$(TARGET_LDFLAGS) -lcrypto -lteec -lpthread
endef

define BRIDGE_DAEMON_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/bridge-daemon $(TARGET_DIR)/usr/bin/bridge-daemon
endef

ifeq ($(BR2_PACKAGE_BRIDGE_DAEMON_DEV_CRYPTO),y)
define BRIDGE_DAEMON_INSTALL_DEV_SRS
	$(INSTALL) -D -m 0644 $(@D)/data/srs-g1-be.bin \
		$(TARGET_DIR)/usr/share/osumania/srs-g1-be.bin
	$(INSTALL) -D -m 0644 $(@D)/data/srs-manifest.json \
		$(TARGET_DIR)/usr/share/osumania/srs-manifest.json
endef
BRIDGE_DAEMON_POST_INSTALL_TARGET_HOOKS += BRIDGE_DAEMON_INSTALL_DEV_SRS
endif

$(eval $(generic-package))
