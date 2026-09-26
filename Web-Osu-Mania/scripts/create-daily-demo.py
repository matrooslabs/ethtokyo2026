"""Rebuild the small, original local test chart with generated audio; no game inputs."""
import io
import math
from pathlib import Path
import struct
import wave
import zipfile
root = Path(__file__).resolve().parent.parent
(root / "public/beatmaps").mkdir(parents=True, exist_ok=True)
out = io.BytesIO()
with wave.open(out, "wb") as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(22050)
    audio.writeframes(b"".join(struct.pack("<h", int(900 * math.sin(i * 2 * math.pi * 220 / 22050))) for i in range(22050 * 4)))
with zipfile.ZipFile(root / "public/beatmaps/daily-demo.osz", "w", zipfile.ZIP_DEFLATED) as archive:
    for name, data in [("daily-demo.osu", (root / "tests/fixtures/daily-demo.osu").read_bytes()), ("demo.wav", out.getvalue())]:
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)
