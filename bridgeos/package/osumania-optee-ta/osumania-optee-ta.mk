################################################################################
# osu!mania constrained OP-TEE signer TA
################################################################################

OSUMANIA_OPTEE_TA_VERSION = 1.0
OSUMANIA_OPTEE_TA_SITE = $(BR2_EXTERNAL_RADXA_ZERO3_RT_PATH)/optee/osumania_signer
OSUMANIA_OPTEE_TA_SITE_METHOD = local
OSUMANIA_OPTEE_TA_DEPENDENCIES = optee-os
OSUMANIA_OPTEE_TA_LICENSE = BSD-2-Clause AND Zlib
OSUMANIA_OPTEE_TA_LICENSE_FILES = ta/third_party/micro-ecc/LICENSE.txt

OSUMANIA_OPTEE_TA_MAKE_OPTS = \
	CROSS_COMPILE=$(TARGET_CROSS) \
	TA_DEV_KIT_DIR=$(OPTEE_OS_SDK)

ifeq ($(BR2_PACKAGE_OSUMANIA_OPTEE_TA_DEV_KEY),y)
OSUMANIA_OPTEE_TA_MAKE_OPTS += CFG_OSUMANIA_DEV_INSECURE_KEY=y
endif

define OSUMANIA_OPTEE_TA_BUILD_CMDS
	$(TARGET_MAKE_ENV) $(MAKE) $(OSUMANIA_OPTEE_TA_MAKE_OPTS) -C $(@D)/ta
endef

define OSUMANIA_OPTEE_TA_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0444 $(@D)/ta/91fc6874-8551-4b42-a95d-6ee4a147f421.ta \
		$(TARGET_DIR)/lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta
endef

$(eval $(generic-package))
