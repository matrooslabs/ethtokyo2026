// SPDX-License-Identifier: BSD-3-Clause
/*
 * OTP LAB ONLY. No OTP programming commands, key derivation, signing TA or
 * development HUK. Normal World sees only two PMUGRF occupancy/status words.
 *
 * Rockchip's OTP guide gives 224 Protected OEM bytes. Pinned RK3568 BL32
 * v2.16 checks relative offsets below 0xe0 and adds 0x2a0 for BOTH OEM
 * read and write (binary SHA-256 69cf1dc21ac0bd1e4a4eec93ee35eea204f117b2168591226c0d112983e06992,
 * image addresses 0x08421858-0x084218ac and 0x08421928-0x084219a0).
 * The first 16 Protected OEM bytes and four separate 32-byte OEM cipher-key
 * slots at raw 0x200 + key_id * 0x20 are read twice in Secure World. This
 * matches vendor rk_otp_s_read and rk_otp_oem_otp_key_is_written callsites.
 * Only zero/nonzero presence bits leave Secure World; nonzero is not proof of
 * a usable, device-unique HUK or any user's signing key.
 * ECC-enabled SBPI reads follow pinned TF-A rk3568/drivers/otp/otp.c.
 * CRU_SOFTRST_CON28 is +0x470 in Rockchip RK3568 TRM Part1 v1.3 p.146;
 * the pinned TF-A soc.h says +0x370 (conflicts with the register table),
 * so the lab uses the documented OTP PHY reset address, not that macro.
 */
#include <common.h>
#include <initcall.h>
#include <io.h>
#include <kernel/delay.h>
#include <mm/core_memprot.h>
#include <platform_config.h>
#include <string.h>
#include <string_ext.h>

#define OTP_OEM_START           0x2a0u
#define OTP_KEY_BYTES           16u
#define OEM_KEY_START           0x200u
#define OEM_KEY_BYTES           32u
#define OEM_KEY_COUNT           4u
#define OEM_KEY_STATUS_REG7     0x021cu
#define OEM_KEY_STATUS_MAGIC    0x4b455900u /* 'KEY'; low byte is occupied mask */
#define OTP_STATUS_REG8         0x0220u
#define OTP_STATUS_MAGIC        0x4f545000u /* 'OTP' and status byte */
#define OTP_LAB_ENTERED         1u
#define OTP_LAB_READ_ERROR      2u
#define OTP_LAB_UNSTABLE        3u
#define OTP_LAB_BLANK           4u
#define OTP_LAB_NONZERO         5u
#define CRU_OTP_PHY_GATE        (0x300u + 34u * 4u)
#define CRU_OTP_PHY_RESET       0x470u
#define SCRU_OTP_GATE           0x184u
#define SGRF_OTP_CONFIG         0x008u
#define OTP_SBPI_CTRL           0x020u
#define OTP_CMD_VALID           0x024u
#define OTP_CS_VALID            0x028u
#define OTP_USER_CTRL           0x100u
#define OTP_USER_QP             0x120u
#define OTP_INT_STATUS          0x304u
#define OTP_CMD(n)             (0x1000u + (n) * 4u)
#define OTP_DATA               0x2000u
#define PHY_PCLK               BIT(13)
#define PHY_RESETN             BIT(15)
#define SECURE_CLOCKS          (BIT(7) | BIT(6) | BIT(5))
#define OTP_SECURE             BIT(1)
#define OTP_CKE                BIT(2)
#define SBPI_ENABLE            BIT(0)
#define SBPI_CS_AUTO           BIT(2)
#define MASK(bits)             ((uint32_t)(bits) << 16)

static void report_status(unsigned int code)
{
	vaddr_t pmu = (vaddr_t)phys_to_virt_io(PMUGRF_BASE, PMUGRF_SIZE);
	if (pmu)
		io_write32(pmu + OTP_STATUS_REG8, OTP_STATUS_MAGIC | code);
}

static void report_key_status(unsigned int code)
{
	vaddr_t pmu = (vaddr_t)phys_to_virt_io(PMUGRF_BASE, PMUGRF_SIZE);
	if (pmu)
		io_write32(pmu + OEM_KEY_STATUS_REG7, OEM_KEY_STATUS_MAGIC | code);
}

static bool wait_sbpi(vaddr_t otp)
{
	for (unsigned int i = 0; i < 10000; ++i) {
		if (io_read32(otp + OTP_INT_STATUS) & BIT(1)) {
			io_write32(otp + OTP_INT_STATUS, 0xffff0002u);
			return true;
		}
		udelay(1);
	}
	return false;
}

static bool read_secure_halfword(vaddr_t otp, vaddr_t cru, unsigned int address,
				 uint16_t *out)
{
	static const uint8_t sequence[8] = { 0, 0, 0x40, 0x40, 0, 2, 0x80, 0x81 };
	bool good = false;

	/* TF-A SBPI sequence; +0x470 is the OTP PHY reset register in TRM. */
	io_write32(cru + CRU_OTP_PHY_RESET, MASK(PHY_RESETN) | PHY_RESETN);
	udelay(2);
	io_write32(cru + CRU_OTP_PHY_RESET, MASK(PHY_RESETN));
	udelay(1);
	io_write32(otp + OTP_USER_CTRL, MASK(BIT(0)));
	udelay(2);

	io_write32(otp + OTP_SBPI_CTRL, (0xffu << 24) | (2u << 8));
	io_write32(otp + OTP_CMD_VALID, 0xffff0001u);
	io_write32(otp + OTP_CMD(0), 0xfau);
	io_write32(otp + OTP_CMD(1), 0); /* enable ECC for Protected OEM */
	io_write32(otp + OTP_SBPI_CTRL, MASK(SBPI_ENABLE) | SBPI_ENABLE);
	if (!wait_sbpi(otp))
		return false;

	io_write32(otp + OTP_SBPI_CTRL, MASK(SBPI_CS_AUTO) | SBPI_CS_AUTO);
	io_write32(otp + OTP_CS_VALID, 0xffff0000u);
	io_write32(otp + OTP_SBPI_CTRL, (0xffu << 24) | (2u << 8));
	io_write32(otp + OTP_CMD_VALID, 0xffff0002u);
	io_write32(otp + OTP_CMD(0), 0xfcu); /* secure OTP READ */
	io_write32(otp + OTP_CMD(1), address & 0xffu);
	io_write32(otp + OTP_CMD(2), (address >> 8) & 0xffu);
	io_write32(otp + OTP_SBPI_CTRL, MASK(SBPI_ENABLE) | SBPI_ENABLE);
	if (!wait_sbpi(otp))
		return false;

	io_write32(otp + OTP_CMD_VALID, 0xffff0007u);
	for (unsigned int i = 0; i < 8; ++i)
		io_write32(otp + OTP_CMD(i), sequence[i]);
	io_write32(otp + OTP_SBPI_CTRL, MASK(SBPI_ENABLE) | SBPI_ENABLE);
	if (!wait_sbpi(otp))
		return false;
	good = !(io_read32(otp + OTP_USER_QP) & 0xe0u);
	if (good)
		*out = (uint16_t)io_read32(otp + OTP_DATA + 0x20u) |
		       (uint16_t)(io_read32(otp + OTP_DATA + 0x24u) << 8);
	io_write32(otp + OTP_CMD_VALID, 0xffff0001u);
	io_write32(otp + OTP_CMD(0), 0xa0u); /* release SBPI read, not program */
	io_write32(otp + OTP_CMD(1), 0);
	io_write32(otp + OTP_SBPI_CTRL, MASK(SBPI_ENABLE) | SBPI_ENABLE);
	if (!wait_sbpi(otp))
		good = false;
	io_write32(otp + OTP_INT_STATUS, 0xffff0003u);
	return good;
}

static TEE_Result otp_lab_boot(void)
{
	vaddr_t otp = (vaddr_t)phys_to_virt_io(OTP_S_BASE, OTP_S_SIZE);
	vaddr_t cru = (vaddr_t)phys_to_virt_io(CRU_BASE, CRU_SIZE);
	vaddr_t scru = (vaddr_t)phys_to_virt_io(SCRU_BASE, SCRU_SIZE);
	vaddr_t sgrf = (vaddr_t)phys_to_virt_io(SGRF_BASE, SGRF_SIZE);
	uint16_t first[OTP_KEY_BYTES / 2] = { 0 };
	uint16_t second[OTP_KEY_BYTES / 2] = { 0 };
	uint16_t key_first[OEM_KEY_BYTES / 2] = { 0 };
	uint16_t key_second[OEM_KEY_BYTES / 2] = { 0 };
	uint32_t phy_gate = 0, secure_gate = 0, security = 0;
	unsigned int status = OTP_LAB_READ_ERROR;
	unsigned int key_status = 0xffu; /* Read failure, never treat as empty. */

	report_status(OTP_LAB_ENTERED);
	report_key_status(0xfeu); /* Probe entered, no secret data exported. */
	if (!otp || !cru || !scru || !sgrf)
		goto out;
	phy_gate = io_read32(cru + CRU_OTP_PHY_GATE) & PHY_PCLK;
	secure_gate = io_read32(scru + SCRU_OTP_GATE) & SECURE_CLOCKS;
	security = io_read32(sgrf + SGRF_OTP_CONFIG) & (OTP_SECURE | OTP_CKE);
	io_write32(cru + CRU_OTP_PHY_GATE, MASK(PHY_PCLK));
	io_write32(scru + SCRU_OTP_GATE, MASK(SECURE_CLOCKS));
	io_write32(sgrf + SGRF_OTP_CONFIG,
		   MASK(OTP_SECURE | OTP_CKE) | OTP_SECURE | OTP_CKE);
	for (unsigned int pass = 0; pass < 2; ++pass) {
		for (unsigned int i = 0; i < OTP_KEY_BYTES / 2; ++i) {
			uint16_t *word = pass ? &second[i] : &first[i];
			if (!read_secure_halfword(otp, cru, (OTP_OEM_START / 2) + i, word))
				goto restore;
		}
	}
	if (memcmp(first, second, sizeof(first))) {
		status = OTP_LAB_UNSTABLE;
		goto restore;
	}
	status = OTP_LAB_BLANK;
	for (unsigned int i = 0; i < OTP_KEY_BYTES / 2; ++i)
		if (first[i] != 0)
			status = OTP_LAB_NONZERO;
	key_status = 0;
	for (unsigned int slot = 0; slot < OEM_KEY_COUNT; ++slot) {
		unsigned int address = (OEM_KEY_START + slot * OEM_KEY_BYTES) / 2;
		for (unsigned int pass = 0; pass < 2; ++pass) {
			for (unsigned int i = 0; i < OEM_KEY_BYTES / 2; ++i) {
				uint16_t *word = pass ? &key_second[i] : &key_first[i];
				if (!read_secure_halfword(otp, cru, address + i, word)) {
					key_status = 0xffu;
					goto restore;
				}
			}
		}
		if (memcmp(key_first, key_second, sizeof(key_first))) {
			key_status = 0xfeu;
			goto restore;
		}
		for (unsigned int i = 0; i < OEM_KEY_BYTES / 2; ++i)
			if (key_first[i] != 0)
				key_status |= BIT(slot);
		memzero_explicit(key_first, sizeof(key_first));
		memzero_explicit(key_second, sizeof(key_second));
	}
restore:
	io_write32(sgrf + SGRF_OTP_CONFIG, MASK(OTP_SECURE | OTP_CKE) | security);
	io_write32(scru + SCRU_OTP_GATE, MASK(SECURE_CLOCKS) | secure_gate);
	io_write32(cru + CRU_OTP_PHY_GATE, MASK(PHY_PCLK) | phy_gate);
out:
	report_key_status(key_status);
	report_status(status);
	memzero_explicit(first, sizeof(first));
	memzero_explicit(second, sizeof(second));
	memzero_explicit(key_first, sizeof(key_first));
	memzero_explicit(key_second, sizeof(key_second));
	return TEE_SUCCESS; /* Diagnostics never block a recoverable test boot. */
}
boot_final(otp_lab_boot);
