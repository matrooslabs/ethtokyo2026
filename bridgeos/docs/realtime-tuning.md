# Runtime and real-time tuning

This tree contains a Buildroot userspace bridge, **not a verified latency claim**. There are no measurements from a Radxa ZERO 3W in this repository. It requires the pinned PREEMPT_RT kernel with built-in ConfigFS HID gadget (`CONFIG_USB_CONFIGFS_F_HID`), hidraw, evdev, DWC3 peripheral mode on OTG0 and an independent host port. A single USB controller cannot normally act as host and peripheral on the same port. Connect the keyboard to the **host** port and the upstream computer to the **peripheral/OTG** port. Confirm the actual board port mapping, power budget, PHY and UDC before connecting production equipment.

The rootfs overlay `/init` mounts proc/sysfs/devtmpfs and tmpfs `/run`, then execs BusyBox `/sbin/init`; devtmpfs supplies `/dev/hidg*` dynamically. The selected kernel has `CONFIG_UEVENT_HELPER=n`, so writing `/proc/sys/kernel/hotplug` would fail under `set -e` and abort `/init` before HID setup. That obsolete mdev path has been removed. `S99bridge` mounts ConfigFS, creates keyboard and vendor HID functions, binds the UDC, applies `bridge-rt-policy`, waits for `/dev/hidg0` and `/dev/hidg1`, then starts `bridge-daemon`. Both profiles provision the user-supplied `0xd86a:0x1000` in `board/radxa-zero3-rt/rootfs-overlay/etc/bridge-gadget.conf`; assignment/ownership was not independently verified. The file has this form:

```sh
BRIDGE_USB_VID=0xNNNN
BRIDGE_USB_PID=0xNNNN
BRIDGE_USB_SERIAL=unique-serial-per-device
BRIDGE_USB_MANUFACTURER='Your organization'
BRIDGE_USB_PRODUCT='Your HID bridge'
# BRIDGE_UDC=name  # only if multiple UDCs exist
```

Debug and production use the same user-supplied identity; debug adds tracing tools and a UART login, not a different USB product. Rebuild after changing the config file. Enumeration still requires confirmation on the actual board and PC.

Use real hexadecimal digits in place of `NNNN`; `0x0000` is rejected. A serial unique per physical device is recommended. A HID bridge controls the attached host's keyboard: isolate/test it before enabling input from untrusted keyboards. `/etc/bridge-rt.conf` is optional:

```sh
BRIDGE_RT_CPU=2
BRIDGE_HOST_IRQ_CPU=1
BRIDGE_GADGET_IRQ_CPU=3
# BRIDGE_HOST_IRQS='N [N...]'    # only after confirming host IRQs in /proc/interrupts
# BRIDGE_GADGET_IRQS='M [M...]'  # only after confirming gadget IRQs in /proc/interrupts
BRIDGE_RT_PRIORITY=60
BRIDGE_KEYBOARD_DEVICE=auto
# BRIDGE_KEYBOARD_DEVICE=/dev/input/eventN
# BRIDGE_VENDOR_DEVICE=/dev/hidrawN
```

CPU2 bridge thread, CPU1 host IRQ and CPU3 gadget IRQ are starting hypotheses, not measured optima. On the captured board `/proc/interrupts` showed host label `xhci-hcd:usb1` on IRQ 29, but platform sysfs exposed no IRQ attributes, so the old policy failed (`host=0 gadget=0`). The policy first follows sysfs controller ancestry; if absent, it now matches the **enumerated host bus** under `fd000000.usb` to the live `xhci-hcd:usbN` label. After a gadget actually binds, the pinned DWC3 driver requests its IRQ under the `dwc3` label; the sole `fcc00000.usb` UDC is used to validate that lookup. No numeric IRQ is hard-coded. Each found IRQ is pinned by `/proc/irq/N/smp_affinity_list` and checked against `effective_affinity_list`; ambiguous/shared/unsteerable IRQs remain fatal. It reports available IRQ-thread policy/priority readback without claiming tuning. CPUfreq `performance` is applied with readback; absent CPUfreq warns. The daemon pins CPU2, prefaults stack, locks memory with `mlockall`, then requests FIFO priority 60. `isolcpus`, `nohz_full`, `rcu_nocbs`, fixed clock, disabled idle or thermal overrides remain unmeasured and unused.

## What actually crosses the bridge

Keyboard discovery inspects USB evdev event nodes, requires `KEY_A` and `KEY_ENTER`, and selects the first keyboard in `/dev/input/event0..63`; or pin one node in `bridge-rt.conf`. It translates Linux `EV_KEY` into an 8-byte USB boot keyboard report (6 keys plus modifier byte); >6 keys uses HID ErrorRollOver, not silent truncation. `SYN_DROPPED` triggers `EVIOCGKEY` state resynchronization. Removal releases keys, then discovery resumes. Only supported usages are mapped; nonstandard keyboard usages, consumer/media controls, mouse events, NKRO semantics and HID keyboard LED writes are **not** forwarded. Input event timestamps are set to `CLOCK_MONOTONIC`; metrics measure evdev timestamp to a successful gadget userspace write, *not* USB bus transmission or target OS delivery. The fixed descriptors and automatic first-device choice require validation against the intended physical keyboard.

Vendor function `/dev/hidg1` uses a fixed **vendor-defined**, 64-byte input/output descriptor; it is not a transparent generic HID clone. Explicit `BRIDGE_VENDOR_DEVICE=/dev/hidrawN` is required to open a host hidraw device; arbitrary HID descriptors cannot be mirrored into an already-enumerated ConfigFS interface. The 64-byte vendor report has `[0]='B', [1]=1, [2]=sequence modulo 256, [3]=flags (bit0 first, bit1 last), [4:6]=total raw report length little-endian, [6]=fragment index, [7]=payload length (1..56), [8:]=raw bytes; unused bytes are zero. Fragments must arrive in order; a complete report is at most 4096 bytes, up to 74 frames. The upstream application must implement this exact framing and know the *physical device's* report descriptor, report IDs and output/feature semantics. Hidraw `read()` byte layout varies with whether report IDs are present; hidraw `write()` requires report ID byte zero for unnumbered output reports. The bridge never negotiates those details, emulates feature reports, merges multiple devices, or translates reports. Selecting a keyboard hidraw endpoint does **not** make its device-specific reports into the boot keyboard interface. Fragment losses are detectable by sequence/reassembly; nonblocking queues are bounded and reports can drop under backpressure. For truly transparent arbitrary HID, descriptor-specific discovery, enumeration lifetime and SET_REPORT/GET_REPORT emulation would need a different, tested design.

The ConfigFS descriptor is an 8-byte boot keyboard plus a 64-byte vendor HID input/output. The user reported **no forwarded keys** first with `interval=1` on both functions and then with an initial default-interval rollback; without a capture from either failure the interval is not established as the cause. Both current profiles leave the ConfigFS interval unset and therefore request the pinned kernel's High-Speed default `bInterval=4` (nominal 1 ms), while retaining High-Speed capability. The current production image is byte-identical to the pre-experiment image that previously forwarded successfully, yet the later user report says forwarding fails. The matching debug FAT snapshot now requests a daemon `SIGUSR1` stats snapshot after 60 seconds of activity (`COUNTERS.TXT`) and records startup, selected input, UDC speed and interval. Successful userspace writes, drops, macOS host polling, and physical wire timing remain separate observations; neither this rollback nor `bInterval` establishes a software-latency bound.
