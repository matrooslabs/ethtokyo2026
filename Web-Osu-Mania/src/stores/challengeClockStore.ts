import { create } from "zustand";

type ClockSnapshot = {
  deadlineMs: number | null;
  nowMs: number;
  phase: "upcoming" | "scoring" | "claims" | null;
  simulated: boolean;
};

type ClockState = ClockSnapshot & {
  setClock: (snapshot: ClockSnapshot) => void;
  clearClock: () => void;
};

const idle: ClockSnapshot = { deadlineMs: null, nowMs: 0, phase: null, simulated: false };

/** Page state supplies the clock; the header never makes a second Sui RPC request. */
export const useChallengeClockStore = create<ClockState>((set) => ({
  ...idle,
  setClock: (snapshot) => set(snapshot),
  clearClock: () => set((state) => state.deadlineMs === null ? state : idle),
}));
