#!/usr/bin/env python3
"""Real HTTP -> real local SP1 core proof -> download -> independent host verification.

Requires built server and host binaries. Does not use mock proving or an external network.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from prove_http import ProofClient

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["core", "groth16"], default="core")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="mania-http-") as temporary:
        folder = Path(temporary)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        token = secrets.token_hex(32)
        environment = dict(os.environ, PROVER_API_TOKEN=token)
        with (folder / "server.log").open("w") as log:
            command = [
                str(ROOT / "target/release/mania-proof-server"), "--bind", f"127.0.0.1:{port}",
                "--host-bin", str(ROOT / "host/target/release/mania-sp1-host"),
                "--data-dir", str(folder / "jobs"), "--timeout-seconds", str(args.timeout_seconds),
            ]
            if args.mode == "groth16":
                command.append("--enable-groth16")
            process = subprocess.Popen(command, env=environment, stdout=log, stderr=log)
            try:
                for _ in range(120):
                    if process.poll() is not None:
                        raise RuntimeError((folder / "server.log").read_text())
                    try:
                        with urllib.request.urlopen(url + "/healthz", timeout=1):
                            break
                    except (OSError, urllib.error.URLError):
                        time.sleep(0.25)
                else:
                    raise TimeoutError("server did not start")
                try:
                    urllib.request.urlopen(url + "/v1/meta", timeout=2)
                    raise AssertionError("unauthenticated metadata should be rejected")
                except urllib.error.HTTPError as error:
                    assert error.code == 401
                client = ProofClient(url, token)
                metadata = client.request("/v1/meta")
                play = json.loads((ROOT / "fixtures/perfect.json").read_text())
                job = client.prove(play, args.mode, folder / "download", wait_seconds=args.timeout_seconds + 60)
                proof = json.loads((folder / "download/proof.json").read_text())
                assert job["score"] == proof["result"]["score"] == 1000000
                assert proof["vkey"] == metadata["vkey"]
                assert proof["locallyVerified"] is True
                if args.mode == "core":
                    assert proof["proof"] is None
                else:
                    assert proof["proof"].startswith("0x") and len(proof["proof"]) > 10
                subprocess.run([
                    str(ROOT / "host/target/release/mania-sp1-host"), "verify",
                    str(ROOT / "fixtures/perfect.json"), str(folder / "download"),
                ], check=True)
                print(f"PASS: authenticated HTTP {args.mode} proving, maximum score, downloaded binary verification")
            except Exception:
                print((folder / "server.log").read_text(), flush=True)
                for prover_log in (folder / "jobs").glob("*/prover.log"):
                    print(prover_log.read_text()[-12000:], flush=True)
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    main()
