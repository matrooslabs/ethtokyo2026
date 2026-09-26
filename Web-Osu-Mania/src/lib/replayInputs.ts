export type RecordedInput = [column: number, time: number, isDown: boolean];
// Record actual browser transitions only. Game cleanup may release already-up keys.
export function recordTransition(states: boolean[], inputs: RecordedInput[], column: number, time: number, isDown: boolean) {
  if ((states[column] ?? false) === isDown) return;
  states[column] = isDown;
  inputs.push([column, time, isDown]);
}
