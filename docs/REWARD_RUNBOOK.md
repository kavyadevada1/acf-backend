# Reward engine runbook

What to run, in what order, and how to tell whether it worked — when the automatic
schedule has not run, or you want to drive it by hand.

**You never need to look up a checkpoint id or an epoch id.** Every command either
discovers what is pending or tells you. If you only remember one thing, remember
this block:

```bash
npm run reward:epoch       -- --catch-up     # 1  self rewards        (no key)
npm run reward:team        -- --catch-up     # 2  team rewards        (no key)
npm run settlement:calculate                 # 3  build the claim root (no key)
npm run settlement:execute -- --dry-run      # 4  review
npm run settlement:execute                    # 5  publish it          (KEY)
npm run dao-revenue:catch-up                  # 6  DAO revenue amounts (no key)
npm run dao-revenue:execute -- --dry-run     # 7  review
npm run dao-revenue:execute                   # 8  pay it out          (KEY)
```

Steps 5 and 8 sign transactions and need `EPOCH_EXECUTOR_PRIVATE_KEY` in the
environment. Everything else is pure calculation and reads.

Repeat steps 7–8 until it says `no executable DAO revenue epoch` — each run handles
the oldest pending epoch.

---

## What each step does

| # | Command | What it does | Signs? |
|---|---|---|---|
| 1 | `reward:epoch -- --catch-up` | Computes each stake's own staking reward for every 12-hour epoch that has closed. Writes `RewardEpoch` + one `StakeRewardEntry` per stake. Also discovers stakes made on chain that the app never indexed. | no |
| 2 | `reward:team -- --catch-up` | Computes Level, Rank and Global rewards from the referral graph. Needs step 1 for the same epoch. | no |
| 3 | `settlement:calculate` | Turns everything earned so far into one cumulative Merkle root and tells you the exact ACF to fund. Creates a `CALCULATED` checkpoint. Nothing is claimable yet. | no |
| 4 | `settlement:execute -- --dry-run` | Checks the manifest, the deployment wiring, the live chain state and the Treasury balance. Prints the two calls it would make. Needs no key. | no |
| 5 | `settlement:execute` | `Treasury.fundRewardEpoch` then `Withdrawal.finalizeEpoch`. **After this, rewards are claimable.** | **yes** |
| 6 | `dao-revenue:catch-up` | Computes DAO member revenue — 5% of the epoch's self-staking reward, split by recorded active USDT contribution. Needs step 1 only, not step 2. | no |
| 7 | `dao-revenue:execute -- --dry-run` | Same kind of review as step 4, plus the Treasury headroom check. | no |
| 8 | `dao-revenue:execute` | `Treasury.fundDAORevenueEpoch` then `distributeBatch`. ACF lands directly in each member's own external wallet. | **yes** |

### Why steps 3–5 are separate

Steps 1–2 only *calculate*. A user can see what they earned, but cannot take it.

Step 5 is what makes it claimable, and it is two transactions, both required:

- **fund** — moves the ACF to the Withdrawal contract. Without it `claim()` reverts
  with `InsufficientBacking`, however correct the root is.
- **finalize** — publishes the Merkle root. The contract stores one `bytes32`, not a
  row per user; at claim time the user supplies their own amounts and a proof, and the
  contract rebuilds the leaf from `msg.sender` and checks it. That is what makes
  "who may claim what" verifiable without storing it.

---

## One-time setup (already done on Amoy — only needed for a fresh deployment)

```bash
npm run dao-revenue:backfill-config -- --from=<ACFDAO deployment block>
```

This indexes the DAO's revenue-config event history, so a past epoch is always
priced with the thresholds and percentage that were in force *then*. It reads logs in
10-block chunks because the RPC caps the range, so expect ~30 minutes. Calculation
refuses to run without it rather than using today's config for an old epoch.

**Settlement needs no setup step.** On a fresh deployment the first checkpoint chains from
the virgin Withdrawal's own zero baseline — no epoch, no root, nothing entitled, nothing
claimed — and `settlement:calculate` recognises that automatically. The baseline is derived
from live chain state, never stored, so it publishes no root, no leaf and no entitlement.

If the database is empty but the Withdrawal has *already* settled something, calculation
refuses rather than restarting the cumulative chain from zero, and the error names the live
value that disagrees. That means settlement history exists on chain which this database does
not have: restore the matching database, or point the backend at the Withdrawal the
checkpoints were calculated against.

---

## Finding out where things stand

```bash
npm run dao-revenue:calculate              # lists Phase 1 settled range + pending DAO epochs
npm run settlement:execute   -- --dry-run  # the next checkpoint, or "no executable"
npm run dao-revenue:execute  -- --dry-run  # the next DAO epoch, or "no executable"
npm run dao-revenue:status   -- --epoch=<id>
npm run settlement:reconcile               # re-reads chain and corrects local status
npm run dao-revenue:reconcile -- --epoch=<id>
```

`no executable …` means nothing is pending — not that something is broken.

For a user's own position:

```bash
curl -H "Authorization: Bearer <jwt>" localhost:3001/rewards/summary
```

Returns `earnedSelfACF`, `earnedTeamACF`, `publishedSelfACF`, `publishedTeamACF`,
`claimedACF` and a status of `CLAIMABLE | NOTHING_TO_CLAIM`.
`earned` grows from step 2; `published` only changes at step 5.

---

## If something fails

Everything is safe to re-run. Nothing double-funds or double-pays, because the chain
is the authority:

- **A command fails mid-way** — run it again. Funding is skipped when the chain
  already records it, and members already paid are filtered out.
- **A transaction was sent but you lost the receipt** — run `settlement:reconcile` or
  `dao-revenue:reconcile`, which read the chain and correct the local status.
- **Catch-up stops at an epoch** — it is deliberate. Each epoch compounds on the one
  before, so later epochs are not settled until that one is fixed.
- **"Funded with a different amount than the obligation"** — stop. The distributor has
  no sweep function, so this needs a human decision, not a retry.
- **DAO revenue says `NOTHING_TO_DISTRIBUTE`** — that is a terminal, recorded answer
  (programme disabled, no system revenue, or no eligible member at that snapshot), not
  a failure. It will not become payable later.

Nothing is ever marked complete on local state alone: a DAO epoch reaches `COMPLETED`
only when the chain proves every member was paid **and** the distributed total equals
the obligation.

---

## Keys

| Key | Where it lives | Used for |
|---|---|---|
| `EPOCH_EXECUTOR_PRIVATE_KEY` | backend environment, executor processes only | steps 5 and 8 |
| admin / deployer key | your machine, never a server | granting roles, upgrades, config |

The executor account needs `EPOCH_EXECUTOR_ROLE` on Treasury, Withdrawal and the DAO
revenue distributor — granted once with
`smart-contracts/scripts/grant-epoch-executor.ts` — plus native POL for gas. It never
holds ACF.

Leave the key unset for the API and the reward worker. Neither can reach the signer
module, and both run without it.

The admin key must never go on a server: it also carries `DEFAULT_ADMIN` and
`UPGRADER` over the whole protocol, so a compromise of that host would become full
control of the Treasury.

One honest caveat: `EPOCH_EXECUTOR_ROLE` on the Treasury also authorises
`adjustReserve`, which mints up to 3× active stake. No code here calls it, but the key
could. Narrowing that needs a contract change.

---

## Running it on a schedule

Two cron entries, and only one of them needs the key:

```cron
# calculation — steps 1, 2, 3, 6. No key.
5 0,12 * * *   cd /srv/backend && npm run reward:worker

# execution — steps 5 and 8. Needs EPOCH_EXECUTOR_PRIVATE_KEY.
20 0,12 * * *  cd /srv/backend && npm run settlement:execute
25 0,12 * * *  cd /srv/backend && npm run dao-revenue:execute
```

`reward:worker` chains Phase 1 → Phase 2 → DAO config sync → DAO revenue calculation →
settlement calculation in one tick, each in its own try/catch, and holds no signer.

`npm run dao-revenue:executor` is a long-running alternative to the third line: it
polls and processes executable epochs oldest-first.

---

## Epoch arithmetic, for when a date has to be turned into an id

Epochs are 12 hours, aligned to Unix time:

```
epochId    = snapshotAt / 43200
snapshotAt = epochId * 43200          window is [snapshotAt - 43200, snapshotAt)
```

Worked example — the first two epochs this engine settled:

```
epoch 41459   window [1790985600, 1791028800)   2026-10-03 00:00 -> 12:00 UTC
epoch 41460   window [1791028800, 1791072000)   2026-10-03 12:00 -> 2026-10-04 00:00 UTC
```

An epoch can only be settled once its `snapshotAt` has passed.
