/**
 * Prints the two cutover variables, and the timeline they commit you to.
 *
 *   npx tsx scripts/plan-reward-cutover.ts
 *
 * Run it at the moment the cutover is complete — after the ROOT has registered, the Swap is
 * seeded and the smoke test passes — and before the workers start. Reads nothing and writes
 * nothing; the clock is its only input.
 *
 * WHY A FORMULA AND NOT A FIXED NUMBER: an epoch id is `floor(unixSeconds / 43200)`, so the
 * right value changes every twelve hours. A number copied from an earlier run is a number
 * from the past, and a past activation epoch makes the startup sweep settle windows that
 * closed before the protocol existed.
 *
 * `+2` is the first epoch whose WINDOW BEGINS after now, so no paid window straddles the
 * cutover. It can cost at most one unpaid 12-hour window, which is the right way to err: a
 * skipped window is a decision, a backfilled one is a liability.
 */
const EPOCH_SECONDS = 43_200;        // twelve hours
const IST_OFFSET = 5.5 * 3600;       // India has no DST, and neither does UTC

const now = Math.floor(Date.now() / 1000);
const latestCompleted = Math.floor(now / EPOCH_SECONDS);
const activation = latestCompleted + 2;

/** An instant in IST. Printed to the minute: seconds never matter at an epoch boundary. */
const ist = (unix: number): string =>
  `${new Date((unix + IST_OFFSET) * 1000).toISOString().slice(0, 16).replace("T", " ")} IST`;

const snapshotAt = (epochId: number) => epochId * EPOCH_SECONDS;
const windowStart = (epochId: number) => snapshotAt(epochId) - EPOCH_SECONDS;
/** reward:worker runs five minutes past the boundary; settlement:execute twenty. */
const calculatedAt = (epochId: number) => snapshotAt(epochId) + 5 * 60;
const claimableAt = (epochId: number) => snapshotAt(epochId) + 20 * 60;

console.log(`
  now                      ${ist(now)}
  latest completed epoch   ${latestCompleted}   (ended ${ist(snapshotAt(latestCompleted))})

  ─── put these in the backend environment ───────────────────────────────────

  REWARD_ENGINE_ACTIVATION_EPOCH=${activation}
  REGISTERED_EOA_DIRECT_RULE_START_EPOCH=${activation}

  ─── epoch ${activation}: the first window anyone is ever paid for ──────────────────

    window           ${ist(windowStart(activation))}  ->  ${ist(snapshotAt(activation))}
    stake BY         ${ist(windowStart(activation))}  to be included
                     (a position must be 12h old at the window's end to earn from it)
    calculated       ${ist(calculatedAt(activation))}  reward:worker
    CLAIMABLE FROM   ${ist(claimableAt(activation))}  settlement:execute publishes the root

    Staked after ${ist(windowStart(activation))}? Nothing is lost — the first
    reward is epoch ${activation + 1}: calculated ${ist(calculatedAt(activation + 1))},
    claimable ${ist(claimableAt(activation + 1))}.

  ─── deadline ───────────────────────────────────────────────────────────────

    START THE WORKERS BEFORE ${ist(snapshotAt(activation))}.
    After that this number is in the past: re-run this script and use the new one.

  ─── worth knowing ──────────────────────────────────────────────────────────

    - Boundaries are 05:30 and 17:30 IST, every day, forever. Neither UTC nor
      IST observes DST, so these clock times never shift.

    - The first payout is HALF a day. A 12-hour epoch pays half the daily rate:
      1,000 ACF at 0.25%/day earns 1.25 ACF, not 2.50. Compounding starts at the
      epoch after, since the first one has no prior reward to compound on.

    - There is no backfill. Someone staked for a week and someone staked one
      minute before the cutoff both receive exactly one 12-hour reward. Nothing
      before the activation epoch is ever settled, by design.

    - Set both variables ONCE and never change them. After downtime the worker
      resumes from the database by itself — raising them to "today" makes every
      missed epoch permanently unpayable, silently, with no error anywhere.
`);
