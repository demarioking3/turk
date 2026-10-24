/*
 * DROP resolution — kept in its own file so the bluffing rules can change without touching the rest of the game.
 *
 * Current rules:
 * - Everyone reveals. The lowest hand wins the round.
 * - If the dropper has the strictly lowest hand, they win.
 * - If anyone ties or beats the dropper, the dropper is CAUGHT and gets CAUGHT_PENALTY added to their score.
 *   The lowest other player wins; if several tie for lowest, the round is a tie (nobody gets the round win).
 * - 21 Tunk: a dealt hand of exactly TUNK_TOTAL, dropped on the player's first turn before drawing, wins instantly.
 */
export const DROP_RULES = {
  CAUGHT_PENALTY: 10,
  TUNK_TOTAL: 21,
};

/**
 * @param {string} dropper player id
 * @param {Object<string,number>} points hand points for every player in the round
 * @returns {{winners: string[], caught: boolean, penalty: Object<string,number>}}
 */
export function resolveDrop(dropper, points) {
  const others = Object.keys(points).filter((id) => id !== dropper);
  const low = Math.min(...others.map((id) => points[id]));
  if (points[dropper] < low) return { winners: [dropper], caught: false, penalty: {} };
  return {
    winners: others.filter((id) => points[id] === low),
    caught: true,
    penalty: { [dropper]: DROP_RULES.CAUGHT_PENALTY },
  };
}

/** True when this drop counts as a 21 Tunk. */
export function isTunk({ handTotal, handSize, isFirstTurn, hasDrawn }) {
  return isFirstTurn && !hasDrawn && handSize === 5 && handTotal === DROP_RULES.TUNK_TOTAL;
}
