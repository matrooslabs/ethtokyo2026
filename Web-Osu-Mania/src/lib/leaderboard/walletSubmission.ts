import type { Hex, TransactionReceipt } from "viem";

// Persist before waiting, and reconcile a known hash before asking the wallet again.
export async function submitAndConfirm<T extends { transactionHash?: Hex }>(
  record: T,
  io: {
    send: () => Promise<Hex>;
    persist: (record: T) => Promise<void>;
    wait: (
      hash: Hex,
      replaced: (hash: Hex) => void,
    ) => Promise<TransactionReceipt>;
    accepted: () => Promise<boolean>;
    score: (receipt: TransactionReceipt) => number;
  },
) {
  if (!record.transactionHash) {
    record.transactionHash = await io.send();
    await io.persist(record);
  }
  let replacements = Promise.resolve();
  const receipt = await io.wait(record.transactionHash, (hash) => {
    record.transactionHash = hash;
    replacements = replacements.then(() => io.persist(record));
    // Keep a rejection handled while receipt polling remains pending.
    void replacements.catch(() => {});
  });
  await replacements;
  record.transactionHash = receipt.transactionHash;
  await io.persist(record);
  if (receipt.status !== "success") {
    delete record.transactionHash;
    await io.persist(record);
    throw new Error("Transaction reverted. Proof retained for wallet retry.");
  }
  let score: number;
  try {
    score = io.score(receipt);
  } catch (error) {
    if (!(await io.accepted())) {
      delete record.transactionHash;
      await io.persist(record);
    }
    throw error;
  }
  if (!(await io.accepted()))
    throw new Error("Accepted-score event and consumed session disagree");
  return score;
}
