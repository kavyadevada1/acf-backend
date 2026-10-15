/**
 * Referral graph policy constants.
 *
 * Level Income percentages and unlock thresholds deliberately live with the reward engine,
 * not here — this milestone builds the graph the engine will read, not the engine.
 */

/** Level Income reads at most relative L1-L7. The TREE itself has unlimited depth. */
export const LEVEL_INCOME_MAX_DEPTH = 7;

/**
 * Hard ceiling on nodes a single downline traversal will visit.
 *
 * Exceeding it is an ERROR, never a truncated result: Rank is calculated from the entire
 * downline, so a partial tree returned as if complete would silently understate someone's
 * reward base. See DownlineLimitExceededError.
 */
export const DOWNLINE_MAX_NODES = 100_000;

/** Children fetched per query while walking. Bounds memory, never the result. */
export const DOWNLINE_PAGE_SIZE = 500;

/** Default and maximum page sizes for user-facing direct-referral reads. */
export const DIRECT_PAGE_DEFAULT = 25;
export const DIRECT_PAGE_MAX = 100;
