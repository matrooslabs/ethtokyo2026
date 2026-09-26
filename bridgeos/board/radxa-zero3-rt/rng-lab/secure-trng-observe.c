// SPDX-License-Identifier: BSD-3-Clause
/*
 * EXPERIMENT ONLY, included exclusively in the expendable rng-lab SD image.
 * No other secure-TRNG consumer, signer or TA is installed in that profile.
 * Runs once during OP-TEE boot. Never use these words as seed or key material.
 * No OTP, HUK, key-reader, SEC_TRNG_CHK, nonsecure TRNG or production RNG access.
 *
 * RK3568 TRM Part1 v1.3 pp. 10, 150, 154: TRNG_S 0xfe370000;
 * SCRU 0xfdd10000; SCRU_GATE_CON00[7:6] (0 = clocks enabled),
 * SCRU_SOFTRST_CON02[11:10] (0 = resets released). Write-mask is [31:16].
 * RK3568 TRM Part2 v1.1 pp. 224-227, chapter 5: register offsets below.
 * Part2 p.224 mistakenly calls the self-clearing rng_start field a field of
 * RST_CTL; the register description on p.225 locates it in RNG_CTL[0] and
 * says it clears after the RNG STARTS, not necessarily when data is ready.
 * Therefore the output here is only observed register data, NOT a completed
 * sample, health-test result, entropy estimate, or production RNG proof.
 */
#include <common.h>
#include <initcall.h>
#include <io.h>
#include <kernel/delay.h>
#include <mm/core_memprot.h>
#include <platform_config.h>
#include <trace.h>

#define LAB_TRNG_BASE		0xfe370000u
#define LAB_TRNG_SIZE		SIZE_K(64)
#define LAB_SCRU_BASE		0xfdd10000u
#define LAB_SCRU_SIZE		SIZE_K(64)
#define LAB_STATUS_REG9         0x0224u /* PMUGRF OS scratch; debug image only */
#define LAB_STATUS_MAGIC        0x54524e00u /* TRN, low byte is observation state */
#define SCRU_GATE_CON00		0x0180u
#define SCRU_SOFTRST_CON02	0x0208u
#define TRNG_RST_CTL		0x0004u
#define TRNG_RNG_CTL		0x0400u
#define TRNG_RNG_SAMPLE_CNT	0x0404u
#define TRNG_RNG_DOUT_0		0x0410u
#define TRNG_CLOCKS		(BIT(7) | BIT(6))
#define TRNG_RESETS		(BIT(11) | BIT(10))
#define TRNG_START		BIT(0)
#define TRNG_RESET		BIT(1)
#define TRNG_ENABLE		BIT(1)
#define POLL_LIMIT		10000u /* 10,000 reads, each followed by a 1 us delay */

/* Only this lab image should add this mapping; the board already maps SCRU. */
register_phys_mem_pgdir(MEM_AREA_IO_SEC, LAB_TRNG_BASE, LAB_TRNG_SIZE);

static bool lab_wait_clear(vaddr_t base, unsigned int offset, uint32_t bit)
{
	for (unsigned int i = 0; i < POLL_LIMIT; i++) {
		if (!(io_read32(base + offset) & bit))
			return true;
		udelay(1);
	}
	return false;
}

static void lab_status(uint32_t state)
{
	vaddr_t pmu = (vaddr_t)phys_to_virt_io(PMUGRF_BASE, PMUGRF_SIZE);
	if (pmu)
		io_write32(pmu + LAB_STATUS_REG9, LAB_STATUS_MAGIC | state);
}

/* Call once only in an isolated Secure World diagnostic, never from an RNG API. */
void rk3566_lab_observe_secure_trng(void)
{
	vaddr_t scru = (vaddr_t)phys_to_virt_io(LAB_SCRU_BASE, LAB_SCRU_SIZE);
	vaddr_t trng = (vaddr_t)phys_to_virt_io(LAB_TRNG_BASE, LAB_TRNG_SIZE);
	uint32_t gate = 0;
	uint32_t reset = 0;
	lab_status(1); /* Observer entered; absence on RTDIAG means BL32 did not reach it. */

	if (!scru || !trng) {
		IMSG("TRNG lab: secure MMIO mapping unavailable; no access attempted");
		lab_status(2);
		return;
	}

	gate = io_read32(scru + SCRU_GATE_CON00);
	reset = io_read32(scru + SCRU_SOFTRST_CON02);
	IMSG("TRNG lab: secure clock gate bits 7:6=%#x, reset bits 11:10=%#x",
	     gate & TRNG_CLOCKS, reset & TRNG_RESETS);

	/* 32-bit write-mask writes change only the documented secure-TRNG bits.
	 * Never assert SoC-level reset or touch any other clock, reset or IP.
	 */
	if (gate & TRNG_CLOCKS)
		io_write32(scru + SCRU_GATE_CON00, TRNG_CLOCKS << 16);
	if (reset & TRNG_RESETS)
		io_write32(scru + SCRU_SOFTRST_CON02, TRNG_RESETS << 16);

	/* TRM Part2 p.224 specifies 0x00020002 to clear the RNG's own state
	 * and output; p.225 defines bit 17 as the write-enable for bit 1.
	 */
	io_write32(trng + TRNG_RST_CTL, BIT(17) | TRNG_RESET);
	if (!lab_wait_clear(trng, TRNG_RST_CTL, TRNG_RESET)) {
		IMSG("TRNG lab: local reset did not self-clear within 10,000 polls");
		lab_status(3);
		return;
	}

	/* p.225 RNG_SAMPLE_CNT[15:0], RNG_CTL[5:4] = 256 bits,
	 * [3:2] = slowest ring, [1] = enable. 1079 is only a probe setting,
	 * observed in Rockchip BL32, not a validated entropy configuration.
	 */
	io_write32(trng + TRNG_RNG_SAMPLE_CNT, 1079u);
	io_write32(trng + TRNG_RNG_CTL, (0x3fu << 16) | (3u << 4) |
		   TRNG_ENABLE);
	io_write32(trng + TRNG_RNG_CTL, BIT(16) | TRNG_START);
	if (!lab_wait_clear(trng, TRNG_RNG_CTL, TRNG_START)) {
		IMSG("TRNG lab: start bit did not self-clear within 10,000 polls");
		lab_status(4);
		goto stop;
	}

	IMSG("TRNG lab: RNG_CTL[0] cleared (start acknowledgment only; NOT a health or data-ready indication)");
	for (unsigned int i = 0; i < 8; i++)
		IMSG("TRNG lab: observed DOUT_%u=%#08x (unqualified)", i,
		     io_read32(trng + TRNG_RNG_DOUT_0 + 4u * i));
	lab_status(5); /* Control bit cleared, data observed; NOT qualified entropy. */

stop:
	/* Stop only our control setting. Leave SoC gates/resets enabled rather
	 * than restoring stale values while boot firmware might use this IP.
	 */
	io_write32(trng + TRNG_RNG_CTL, BIT(17));
	io_write32(trng + TRNG_RST_CTL, BIT(17) | TRNG_RESET);
	if (!lab_wait_clear(trng, TRNG_RST_CTL, TRNG_RESET))
		IMSG("TRNG lab: cleanup reset did not self-clear within 10,000 polls");
}

static TEE_Result rk3566_trng_lab_boot(void)
{
	rk3566_lab_observe_secure_trng();
	return TEE_SUCCESS;
}
boot_final(rk3566_trng_lab_boot);
