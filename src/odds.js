// The odds, as something that happens to you. The island starts out against the pig: hens slip
// out of its grasp and a snowball does not last long near hell. Every job finished loads the dice,
// so the order the jobs are done in matters. No three.js in here, so it can be tested in Node.

// How often a grab goes wrong, by jobs finished: [times, out of].
const SLIP = [[3, 4], [1, 2], [1, 3], [1, 6], [0, 1]];
// How many seconds a snowball lasts in the heat around the pit, by jobs finished.
const MELT = [3.5, 5, 7, 10, 14];
const at = (list, count) => list[Math.max(0, Math.min(list.length - 1, count))];

export const HEAT_R = 13;      // the heat reaches this far from the middle of the pit
export const MAX_SLIPS = 2;    // one animal gets away this many times at most, however the dice fall

export const slipChance = (count) => { const [n, d] = at(SLIP, count); return n / d; };
export const slipWords = (count) => { const [n, d] = at(SLIP, count); return n ? `${n} time${n > 1 ? 's' : ''} in ${d}` : 'never'; };
export const meltSeconds = (count) => at(MELT, count);

// Dice that can be replayed from a seed, and fixed by a test: fix = true always goes wrong, false never does.
export function makeDice(rnd) {
  const dice = {
    fix: null,
    wrong(chance, already = 0) {
      if (already >= MAX_SLIPS || chance <= 0) return false;
      return dice.fix === null ? rnd() < chance : dice.fix;
    },
  };
  return dice;
}
