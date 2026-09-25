#!/usr/bin/env python3
"""Locally unlock the configured Sepolia demo signer for this automation run.

Writes a mode-0600 password file under ignored artifacts/private-signing/.
Delete the file after the run. Never paste the password into chat.
"""
import getpass
import os
from pathlib import Path
import subprocess


def main():
    root = Path(__file__).resolve().parents[1]
    secret_dir = root / "artifacts/private-signing"
    secret_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    secret_dir.chmod(0o700)
    password_file = secret_dir / "deployer.password"
    account = Path.home() / ".foundry/keystores/sepolia-deployer"
    if not account.is_file():
        raise SystemExit("sepolia-deployer keystore not found")
    password = getpass.getpass("Sepolia deployer keystore password (hidden): ")
    fd = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(password)
        result = subprocess.run(
            ["cast", "wallet", "address", "--keystore", str(account),
             "--password-file", str(password_file)],
            capture_output=True, text=True,
        )
        if result.returncode:
            raise RuntimeError("Keystore unlock failed; temporary password removed.")
        address = result.stdout.strip()
        if address.lower() != "0x969e3eb1fe56a525e6d87b1a39d3c0aede696d75":
            raise RuntimeError("Unexpected signer; temporary password removed.")
        print("Signer ready:", address)
        print("Temporary password file:", password_file)
        print("Delete this file after the demo transactions finish.")
    except BaseException:
        password_file.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    main()
