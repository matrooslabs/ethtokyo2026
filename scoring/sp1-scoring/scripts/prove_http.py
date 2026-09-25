#!/usr/bin/env python3
"""Submit a PlayInput to the proving API, poll, and download verified proof artifacts."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


class ProofClient:
    def __init__(self, server, token=None):
        self.server = server.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    def request(self, path, data=None, method=None):
        headers = dict(self.headers)
        if data is not None:
            data = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.server + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read(4096).decode(errors="replace")
            raise RuntimeError(f"API returned HTTP {error.code}: {detail}") from error

    def prove(self, play, mode, folder, wait_seconds=3600):
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        if any((folder / name).exists() for name in ["job.json", "proof.json", "proof.bin"]):
            raise ValueError("output directory already contains a job/proof; choose a new directory")
        job = self.request("/v1/proofs", {"mode": mode, "input": play})
        (folder / "job.json").write_text(json.dumps(job, indent=2) + "\n")
        path = f'/v1/proofs/{job["id"]}'
        print(f'Job {job["id"]}: {job["status"]}', flush=True)
        deadline = time.monotonic() + wait_seconds
        previous = job["status"]
        while job["status"] not in ("succeeded", "failed"):
            if time.monotonic() >= deadline:
                raise TimeoutError(f'Client wait expired; server job {job["id"]} may still be running')
            time.sleep(1)
            job = self.request(path)
            (folder / "job.json").write_text(json.dumps(job, indent=2) + "\n")
            if job["status"] != previous:
                print(f'Job {job["id"]}: {job["status"]}', flush=True)
                previous = job["status"]
        if job["status"] == "failed":
            raise RuntimeError(job["error"])
        for name in ["proof.bin", "proof.json"]:
            temporary = folder / (name + ".tmp")
            request = urllib.request.Request(self.server + path + "/" + name, headers=self.headers)
            try:
                with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
                    while chunk := response.read(65536):
                        output.write(chunk)
                temporary.replace(folder / name)
            finally:
                temporary.unlink(missing_ok=True)
        print(f'Verified {mode} artifacts downloaded; score={job["score"]}; directory={folder}', flush=True)
        return job


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--mode", choices=["core", "groth16"], default="core")
    parser.add_argument("--server", default="http://127.0.0.1:8080")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--wait-seconds", type=int, default=3600)
    args = parser.parse_args()
    ProofClient(args.server, os.environ.get("PROVER_API_TOKEN")).prove(
        json.loads(args.input.read_text()), args.mode, args.out, args.wait_seconds
    )


if __name__ == "__main__":
    main()
