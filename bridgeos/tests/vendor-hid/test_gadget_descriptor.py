#!/usr/bin/env python3
import re
from pathlib import Path

script = Path("board/radxa-zero3-rt/rootfs-overlay/usr/sbin/bridge-gadget").read_text()
match = re.search(r"printf '%b' '([^']+)' > \"\$V/report_desc\"", script)
assert match, "Vendor HID report descriptor missing"
descriptor = bytes.fromhex(match.group(1).replace("\\x", ""))
expected = bytes.fromhex(
    "06 60 ff"       # Usage Page 0xFF60
    "09 01"          # Usage 0x01
    "a1 01"          # Application Collection
    "15 00 26 ff 00" # Logical 0..255
    "75 08 95 40 81 02" # 64-byte Input
    "95 40 91 02"    # 64-byte Output
    "c0"
)
assert descriptor == expected, (descriptor.hex(), expected.hex())
assert "report ID" not in script.lower()
assert 'mkdir -p "$G/strings/0x409"' in script
assert '"$G/functions/hid.usb0" "$G/functions/hid.usb1"' in script
print("PASS exact FF60 no-ID 64-byte Input/Output Vendor HID descriptor")
