#!/usr/bin/env python3
"""Read deployment/session IDs from successful mined Foundry receipts, never simulations."""
import argparse
import json
import re
from pathlib import Path

SESSION_OPENED = "0x40694625a02020c6755fb4b75f553bc371b9f5008e8df5b053a1d3e67c3b9d47"


def value_from_receipts(data, kind, contract=None):
    values = []
    receipts = data.get("receipts", [])
    if not receipts:
        raise ValueError("no mined receipts; dry-run output is not a deployment/session")
    if kind == "session" and not re.fullmatch(r"0x[0-9a-fA-F]{40}", contract or ""):
        raise ValueError("session extraction requires --contract ADDRESS")
    for receipt in receipts:
        status = receipt.get("status", 0)
        if (int(status, 0) if isinstance(status, str) else status) != 1:
            raise ValueError("receipt transaction failed")
        if not receipt.get("blockHash") or receipt.get("blockNumber") is None:
            raise ValueError("receipt is not mined")
        if kind == "block":
            number = receipt["blockNumber"]
            values.append(str(int(number, 0) if isinstance(number, str) else number))
        elif kind == "deploy" and receipt.get("contractAddress"):
            address = receipt["contractAddress"]
            if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
                raise ValueError("invalid deployment address")
            values.append(address)
        elif kind == "session":
            for log in receipt.get("logs", []):
                topics = log.get("topics", [])
                if log.get("address", "").lower() == contract.lower() and len(topics) == 4 and topics[0].lower() == SESSION_OPENED:
                    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", topics[1]):
                        raise ValueError("invalid session ID")
                    values.append(topics[1])
    if len(values) != 1:
        raise ValueError(f"expected exactly one {kind} result, found {len(values)}")
    return values[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["deploy", "session", "block"])
    parser.add_argument("broadcast_file", type=Path)
    parser.add_argument("--contract")
    args = parser.parse_args()
    print(value_from_receipts(json.loads(args.broadcast_file.read_text()), args.kind, args.contract))


if __name__ == "__main__":
    main()
