import { openDB } from "idb";
import type { Hex } from "viem";
import type { PaidAttempt, ChartSetup, ProofResult } from "./scoring";
export type Capture = { result: Hex; trace: Hex; webBeatmapHash: string };
export type Saved = {
  attempt: PaidAttempt;
  header?: Hex;
  setup?: ChartSetup;
  capture?: Capture;
  proof?: ProofResult;
  transactionHash?: Hex;
  interrupted?: boolean;
  started?: boolean;
};
const key = (a: PaidAttempt) =>
  `${a.chainId}:${a.registry.toLowerCase()}:${a.sessionId.toLowerCase()}`;
const db = () =>
  openDB("paid-mode-b", 1, {
    upgrade(db) {
      db.createObjectStore("attempts");
    },
  });
export async function save(record: Saved) {
  const d = await db(),
    tx = d.transaction("attempts", "readwrite", { durability: "strict" });
  const previous = (await tx.store.get(key(record.attempt))) as
    Saved | undefined;
  if (
    previous &&
    (JSON.stringify(previous.attempt) !== JSON.stringify(record.attempt) ||
      (previous.header && previous.header !== record.header))
  ) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error("Cannot replace original attempt/header");
  }
  if (
    previous?.capture &&
    JSON.stringify(previous.capture) !== JSON.stringify(record.capture)
  ) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error("Cannot replace an immutable capture");
  }
  await tx.store.put(record, key(record.attempt));
  await tx.done;
}
export async function saved(a: PaidAttempt): Promise<Saved | undefined> {
  return (await db()).get("attempts", key(a));
}
export async function allSaved(): Promise<Saved[]> {
  return (await db()).getAll("attempts");
}
