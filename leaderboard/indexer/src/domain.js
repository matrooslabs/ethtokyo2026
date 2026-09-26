export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export const roundKey = (chartHash, dayId) => `${chartHash.toLowerCase()}:${dayId}`;
export function comparePosition(a, b) {
  for (const field of ['blockNumber', 'transactionIndex', 'logIndex']) {
    const x = BigInt(a[field]), y = BigInt(b[field]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
const add = (a, b) => (BigInt(a) + BigInt(b)).toString();
const rankingOrder = (a, b) => BigInt(a.score) === BigInt(b.score)
  ? comparePosition(a.acceptedAt, b.acceptedAt) : BigInt(a.score) > BigInt(b.score) ? -1 : 1;

// Only canonical, adapter-normalized events enter this reducer. Replaying this
// journal is the recovery mechanism; no independently mutable ranking tables.
export function project(events, metadata = {}) {
  const rounds = new Map(), attempts = new Map(), charts = new Map(), history = [], settlements = [];
  const seen = new Map();
  for (const event of [...events].sort((a, b) => comparePosition(a.position, b.position))) {
    const id = `${event.position.blockNumber}:${event.position.logIndex}`;
    if (seen.has(id)) {
      if (seen.get(id) !== json(event)) throw new Error(`Conflicting event ${id}`);
      continue;
    }
    seen.set(id, json(event));
    const { type, chartHash, dayId, position } = event;
    const key = roundKey(chartHash, dayId);
    if (!rounds.has(key)) rounds.set(key, {
      chartHash, dayId, pot: '0', remainingPot: '0', entries: 0, acceptedScores: 0,
      claimed: false, totalPayouts: '0', totalRefunds: '0', bests: new Map(),
    });
    const round = rounds.get(key);
    if (type === 'entry') {
      if (attempts.has(event.sessionId)) throw new Error(`Duplicate session ${event.sessionId}`);
      if (round.claimed || round.totalRefunds !== '0') throw new Error('Entry after settlement');
      attempts.set(event.sessionId, {
        sessionId: event.sessionId, payer: event.payer, player: event.player, chartHash, dayId,
        amount: event.amount, device: event.device ?? null, entryAt: position, score: null, acceptedAt: null,
      });
      round.entries++;
      round.pot = add(round.pot, event.amount);
      round.remainingPot = add(round.remainingPot, event.amount);
    } else if (type === 'score') {
      const attempt = attempts.get(event.sessionId);
      if (!attempt || attempt.chartHash !== chartHash || attempt.dayId !== dayId || attempt.player !== event.player)
        throw new Error(`Score without matching paid entry ${event.sessionId}`);
      if (attempt.score !== null) throw new Error(`Score replay ${event.sessionId}`);
      if (round.claimed || round.totalRefunds !== '0') throw new Error('Score after settlement');
      attempt.score = event.score;
      attempt.acceptedAt = position;
      round.acceptedScores++;
      const previous = round.bests.get(event.player);
      if (!previous || BigInt(event.score) > BigInt(previous.score)) round.bests.set(event.player, {
        player: event.player, score: event.score, sessionId: event.sessionId, acceptedAt: position,
      });
      if (event.bestScore !== undefined && round.bests.get(event.player).score !== event.bestScore) throw new Error('ScoreRecorded bestScore mismatch');
    } else if (type === 'leader') {
      const leader = [...round.bests.values()].sort(rankingOrder)[0];
      if (!leader || leader.player !== event.player || leader.score !== event.score || leader.sessionId !== event.sessionId)
        throw new Error('LeaderChanged mismatch');
    } else if (type === 'payout' || type === 'refund') {
      if (BigInt(event.amount) > BigInt(round.remainingPot)) throw new Error('Settlement exceeds pot');
      if (type === 'payout') {
        const leader = [...round.bests.values()].sort(rankingOrder)[0];
        if (round.claimed || !leader || leader.player !== event.recipient || event.amount !== round.remainingPot)
          throw new Error('Invalid payout');
        round.claimed = true;
        round.totalPayouts = add(round.totalPayouts, event.amount);
      } else {
        if (round.acceptedScores) throw new Error('Refund with accepted score');
        round.totalRefunds = add(round.totalRefunds, event.amount);
      }
      round.remainingPot = (BigInt(round.remainingPot) - BigInt(event.amount)).toString();
      settlements.push(event);
    } else throw new Error(`Unknown normalized event ${type}`);
    history.push(event);
  }
  for (const round of rounds.values()) {
    round.rankings = [...round.bests.values()].sort(rankingOrder).map((row, i) => ({ rank: i + 1, ...row }));
    round.leader = round.rankings[0] ?? null;
    delete round.bests;
    if (!charts.has(round.chartHash)) charts.set(round.chartHash, {
      chartHash: round.chartHash, metadata: metadata[round.chartHash] ?? null,
      entries: 0, acceptedScores: 0, totalPaid: '0', totalPayouts: '0', totalRefunds: '0', remainingPot: '0', rounds: 0,
    });
    const chart = charts.get(round.chartHash);
    chart.entries += round.entries;
    chart.acceptedScores += round.acceptedScores;
    chart.rounds++;
    chart.totalPaid = add(chart.totalPaid, round.pot);
    for (const field of ['totalPayouts', 'totalRefunds', 'remainingPot']) chart[field] = add(chart[field], round[field]);
  }
  // Metadata-only charts can be displayed before their first paid attempt.
  for (const [chartHash, data] of Object.entries(metadata)) if (!charts.has(chartHash)) charts.set(chartHash, {
    chartHash, metadata: data, entries: 0, acceptedScores: 0, totalPaid: '0', totalPayouts: '0', totalRefunds: '0', remainingPot: '0', rounds: 0,
  });
  return { rounds, attempts, charts, history, settlements };
}
