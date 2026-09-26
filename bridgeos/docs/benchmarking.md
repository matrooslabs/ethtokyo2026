# Benchmarking, without invented latency numbers

**Current status: unmeasured on physical Radxa ZERO 3W.** The repository does not contain board measurements, USB bus traces, percentile claims or end-to-end latency assertions. Builds or x86 QEMU emulation are not substitutes for measured USB interrupts, OTG PHY timing and the target host's polling behavior.

## Capture on the board

Provision a legitimate USB VID:PID, boot the target image, connect a physical USB keyboard on the board's USB host port and a separately powered upstream host on the peripheral/OTG port, verify both `/dev/hidg*` nodes and the ConfigFS bound UDC, then collect diagnostics under representative activity:

```sh
/etc/init.d/S99bridge start           # only if not already started
cat /sys/kernel/config/usb_gadget/bridgeos/UDC
cat /run/bridge-daemon.pid
# Copy scripts/benchmark/capture.sh to the target and execute as root:
./capture.sh /tmp/bridge-capture-001 120
BRIDGE_BENCH_LOAD=stress BRIDGE_TRACE=1 ./capture.sh /tmp/bridge-capture-stress-001 600
```

`capture.sh` checks `/proc/device-tree/model`, refuses a non-Radxa board and refuses to overwrite a capture directory. It records requested and observed duration, board/kernel/cmdline, before/after `/proc/interrupts`, effective IRQ affinity, governor and actual cpufreq, cpuidle usage/time, thermals, USB negotiated speeds/UDC state, dmesg, daemon scheduler/status and on-demand daemon histograms/counters. `BRIDGE_BENCH_LOAD=idle` (default) records a baseline; `stress` requires `stress-ng` and starts CPU/IO/memory load, otherwise it fails rather than relabeling idle data. `BRIDGE_TRACE=1` optionally runs `trace-cmd record` for irq/sched/usb events and explicitly records unavailable tool or trace failures. Inspect `trace.dat` with `trace-cmd report` only when trace capture succeeded; tracepoints vary by kernel, so no raw HID-to-gadget metric is implied by merely collecting this file. If `cyclictest` (Buildroot `rt-tests`) is installed, it runs a 1 ms periodic FIFO 80 scheduler-wakeup histogram; otherwise absence is recorded. Its FIFO task competes with the bridge, so repeat real traffic both with and without cyclictest. Save enough free space for trace data. Copy the capture directory to a development computer and run:

```sh
python3 scripts/benchmark/analyze.py bridge-capture-001
```

The analyzer reports nearest-rank p50/p90/p95/p99/p99.9/p99.99, absolute maximum for external wire samples, requested/observed capture duration and sample count. It suppresses p99.9 below 1,000 samples and p99.99 below 10,000 samples (and lower quantiles below their own reciprocal tail sample counts); no percentile is extrapolated. The daemon's >1000 µs bucket is censored, so any percentile or maximum landing there is printed `>1000us`, not an invented exact value. Cyclictest histogram overflow also prevents an absolute maximum claim.

The daemon counters are deltas between SIGUSR1 snapshots. The application histogram has 1 µs bins 0..1000 µs and one **censored >1000 µs** bin. It measures kernel evdev event timestamp to successful **userspace** `/dev/hidg0` write; it does not include USB host scan/poll before the kernel event, time queued inside gadget endpoint, cable transfer or upstream OS processing. Saturation/drops, disconnects, FIFO throttling, clock changes and interrupt migrations invalidate naive percentile comparisons. A missing input device/no reports must be shown as **UNMEASURED**, not interpreted as zero latency. `analyze.py` treats `cyclictest` wakeup jitter as a distinct distribution and labels histogram overflow rather than hiding it.

If the target metric is **raw host HID report receipt -> gadget endpoint queue**, the evdev histogram is only a proxy: the HID driver can parse one incoming report into multiple `EV_KEY` events after receiving it. Capture matching USB host completion and gadget queue/submit tracepoints on the same kernel monotonic clock (`usbmon` plus suitable ftrace/trace-cmd USB gadget/controller tracepoints, chosen against the running kernel), pair reports by payload/sequence and account for tracepoint availability and tracing overhead. Do not call evdev-to-write p99 a raw-HID-to-gadget p99, and do not claim any p99.9 target from it.

## Measure real end-to-end transport

Use an external logic analyzer or USB protocol analyzer with a **single timestamp clock** covering a physical input trigger (e.g. keyboard test fixture GPIO/switch) and the matching downstream USB interrupt IN completion or output action at the upstream host. Pair unique input/output events, reject lost/unmatched frames explicitly and control debounce, host poll interval, keyboard firmware timing and output scheduling. Record each paired timestamp in a CSV with precisely these headers, in nanoseconds from that same clock:

```csv
input_ns,output_ns
```

Do **not** mix timestamps from separately clocked machines or interpret daemon timestamps as wire timestamps. Analyze an actual populated CSV alongside the board capture:

```sh
python3 scripts/benchmark/analyze.py bridge-capture-001 --wire physical-wire.csv
```

For a host-to-vendor path, report measured distribution separately from the keyboard path; 56-byte fragmentation increases USB frames and can dominate large report latency. Capture packet-level ordering and sequence loss, not merely application write timings. Measure cold/warm starts, idle vs stress-ng load, long-duration thermal behavior and hotplug/recovery independently; report sample sizes, max/p50/p90/p95/p99/p99.9/p99.99 where supported, missing samples, kernel SHA, CPU assignments and host polling settings. Kernel variants such as `nohz_full`, `rcu_nocbs`, cpuidle off and alternate IRQ affinities require distinct boot configurations and fresh board captures; they remain **unmeasured** here. Never describe an unobserved path as measured.

## Troubleshooting actual evidence

- Inspect `/proc/interrupts` before/after and `/proc/irq/N/effective_affinity_list`; parent IRQ sysfs discovery can legitimately report none. A shared/managed interrupt cannot always be steered.
- Compare `/proc/<daemon-pid>/sched` and `/proc/<daemon-pid>/status` (`VmLck`, allowed CPUs), governor readback, `dmesg` for RT throttling, USB resets, PHY and gadget errors. Verify `/dev/input/eventN` maps to a USB keyboard and `/dev/hidrawN` to the intended vendor device.
- Record every nonblocking gadget write failure (`keyboard_dropped`), vendor backpressure drop (`vendor_dropped`) and malformed frame. The histogram only includes successful writes; it is **not** a lossless latency distribution under backpressure.
- Report temperature, CPU frequency, power source, cable/hub, HID report descriptor and upstream OS/driver. These are not constants across setups.
