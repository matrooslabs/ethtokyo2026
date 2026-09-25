import tempfile
import unittest
from pathlib import Path
from make_fixture import make_fixture, micros, parse_osu, validate_notes

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures/demo.osu"


class CanonicalizerTests(unittest.TestCase):
    def test_native_chart(self):
        notes = parse_osu(FIXTURE)
        validate_notes(notes)
        self.assertEqual(len(notes), 4)
        self.assertEqual(notes[1], dict(lane=1, start_us=1500000, end_us=2000000))
        self.assertEqual(make_fixture(notes)["footer"]["event_count"], 8)

    def test_exact_microseconds(self):
        self.assertEqual(micros("123.456"), 123456)
        for time in ["-1", "0.0001", "NaN", "Infinity"]:
            with self.assertRaises(ValueError):
                micros(time)

    def test_reject_unsupported_and_invalid_charts(self):
        original = FIXTURE.read_text()
        for before, after in [("Mode: 3", "Mode: 0"), ("CircleSize: 4", "CircleSize: 7"),
                              ("OverallDifficulty: 5", "OverallDifficulty: 8"),
                              ("1000,1,0", "1000,2,0"), ("2000:0", "1400:0")]:
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "bad.osu"
                path.write_text(original.replace(before, after))
                with self.assertRaises(ValueError):
                    parse_osu(path)

    def test_reject_overlap(self):
        notes = parse_osu(FIXTURE)
        notes[2]["lane"] = 1
        with self.assertRaises(ValueError):
            validate_notes(notes)


if __name__ == "__main__":
    unittest.main()
