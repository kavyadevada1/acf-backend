import { HttpError } from "../lib/errors.js";
import { User, type UserDocument } from "../models/User.js";
import {
  DIRECT_PAGE_DEFAULT, DIRECT_PAGE_MAX, DOWNLINE_MAX_NODES,
  DOWNLINE_PAGE_SIZE, LEVEL_INCOME_MAX_DEPTH,
} from "./policy.js";

/**
 * The referral graph.
 *
 * The canonical edge is a single pointer, `User.referredByUserId`, written once at registration
 * and immutable thereafter. There is no closure table, no materialised path, and deliberately
 * no stored level: a user's "level" only exists RELATIVE to an ancestor being evaluated, so
 * storing an absolute one would be meaningless and would go stale as the tree grows.
 *
 * Depth is unlimited. Level Income happens to read only the first 7 relative levels, but that
 * is a reward rule, not a property of the tree.
 */

/** Raised when a downline walk would exceed its safety ceiling. NEVER a partial result. */
export class DownlineLimitExceededError extends Error {
  readonly code = "DOWNLINE_LIMIT_EXCEEDED";
  readonly leaderUserId: string;
  readonly visited: number;
  readonly limit: number;
  constructor(leaderUserId: string, visited: number, limit: number) {
    super(
      `Downline of ${leaderUserId} exceeded the ${limit}-node safety limit after ${visited} nodes. ` +
        "Refusing to return a partial tree: Rank is calculated from the ENTIRE downline, and a " +
        "truncated one would understate it without any error surfacing.",
    );
    this.name = "DownlineLimitExceededError";
    this.leaderUserId = leaderUserId;
    this.visited = visited;
    this.limit = limit;
  }
}

/** Raised when the stored graph contains a cycle, which registration cannot legitimately create. */
export class ReferralCycleError extends Error {
  readonly code = "REFERRAL_CYCLE";
  readonly userId: string;
  constructor(userId: string, path: string[]) {
    super(`Referral cycle detected at ${userId}: ${path.join(" -> ")} -> ${userId}`);
    this.name = "ReferralCycleError";
    this.userId = userId;
  }
}

export interface ReferralUser {
  userId: string;
  referralCode: string;
  /** Always present: a user exists only once they have authenticated with this address. */
  externalEOA: string;
  joinedAt: string;
}

export interface Upline {
  userId: string;
  /** Distance from the starting user: 1 is the direct sponsor. Always RELATIVE, never absolute. */
  relativeLevel: number;
}

const toReferralUser = (u: UserDocument): ReferralUser => ({
  userId: u.userId,
  referralCode: u.referralCode,
  externalEOA: u.externalEOA,
  joinedAt: (u as unknown as { createdAt: Date }).createdAt.toISOString(),
});

/** Resolves a referral code to its owner. The sole way to select a non-ROOT sponsor. */
export async function getUserByReferralCode(code: string): Promise<UserDocument | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  return User.findOne({ referralCode: trimmed });
}

/** The user's direct sponsor. Null for ROOT, which is the only parentless user. */
export async function getSponsor(userId: string): Promise<UserDocument | null> {
  const user = await User.findOne({ userId });
  if (!user || !user.referredByUserId) return null;
  return User.findOne({ userId: user.referredByUserId });
}

/**
 * Direct referrals — children whose `referredByUserId` is this user. This is relative L1.
 *
 * Always paginated: a leader with thousands of directs must not be able to make a single HTTP
 * response unbounded. Cursor is the opaque `joinedAt|userId` of the last row.
 */
export async function getDirectReferrals(
  userId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ referrals: ReferralUser[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? DIRECT_PAGE_DEFAULT, 1), DIRECT_PAGE_MAX);

  const filter: Record<string, unknown> = { referredByUserId: userId };
  if (options.cursor) {
    const [at, id] = options.cursor.split("|");
    if (at && id) {
      // Strict ordering by (createdAt, userId) keeps the page boundary stable when several
      // users register in the same millisecond.
      filter.$or = [
        { createdAt: { $lt: new Date(at) } },
        { createdAt: new Date(at), userId: { $lt: id } },
      ];
    }
  }

  const rows = await User.find(filter).sort({ createdAt: -1, userId: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? `${(last as unknown as { createdAt: Date }).createdAt.toISOString()}|${last.userId}`
      : null;

  return { referrals: page.map(toReferralUser), nextCursor };
}

/**
 * Direct referral user IDs, for backend aggregation.
 *
 * Global Contribution sums the ACTIVE ACF stake of a leader's direct children, so it needs the
 * identities, not just a count. Unpaginated by design: this is an internal job primitive, never
 * served straight to HTTP.
 */
export async function getDirectReferralUserIds(userId: string): Promise<string[]> {
  const rows = await User.find({ referredByUserId: userId }, { userId: 1 }).lean();
  return rows.map((r) => r.userId as string);
}

/**
 * Every direct referral.
 *
 * NOT the Level unlock input: that rule reads directs registered as-of the epoch's snapshot, which
 * Phase 2 derives itself. This is a live count, for display and for jobs meaning "everyone
 * referred".
 */
export async function countDirectReferrals(userId: string): Promise<number> {
  return User.countDocuments({ referredByUserId: userId });
}

/** How a user's directs stand today. */
export interface DirectReferralStanding {
  /** Every direct referral. */
  total: number;
  /**
   * Directs who qualify their referrer for Level unlock and the Rank direct requirement.
   *
   * Equal to `total`, because registration is the only condition and a direct cannot exist
   * without having registered. It is returned as its own figure rather than left for the caller
   * to assume, so that the day qualification gains a condition, every reader already asks for
   * the right number.
   *
   * "Now" rather than as-of an epoch: a live screen reports the present. Phase 2 never reads
   * this — it recomputes qualification as-of each snapshot so a settled epoch cannot shift.
   */
  qualifying: number;
}

/**
 * A user's direct count, and how many of them qualify.
 *
 * There is no pending state to report: a user exists in the referral tree only once their first
 * registration has succeeded, and that is the whole of the qualification rule.
 */
export async function getDirectReferralStanding(
  userId: string,
): Promise<DirectReferralStanding> {
  const total = await User.countDocuments({ referredByUserId: userId });
  return { total, qualifying: total };
}

/**
 * Ancestors of a user, nearest first, as RELATIVE levels.
 *
 * Walks parent pointers upward and stops at ROOT or at `maxLevels`, whichever comes first, so
 * a user only 3 deep yields 3 entries rather than 7 padded ones. Level Income reads this with
 * the default of 7; the tree continues above and below regardless.
 */
export async function getUplines(
  userId: string,
  maxLevels: number = LEVEL_INCOME_MAX_DEPTH,
): Promise<Upline[]> {
  const uplines: Upline[] = [];
  const seen = new Set<string>([userId]);

  let currentId: string | null = userId;
  for (let level = 1; level <= maxLevels; level++) {
    const current: UserDocument | null = await User.findOne({ userId: currentId });
    if (!current || !current.referredByUserId) break;   // ROOT, or a missing record

    const parentId: string = current.referredByUserId;
    // Registration cannot create a cycle (parents are immutable and point at existing users),
    // so this only fires on corrupted or imported data — where looping forever is far worse.
    if (seen.has(parentId)) throw new ReferralCycleError(parentId, [...seen]);

    seen.add(parentId);
    uplines.push({ userId: parentId, relativeLevel: level });
    currentId = parentId;
  }

  return uplines;
}

/**
 * Visits every descendant of a leader, breadth-first, at unlimited depth.
 *
 * Rank is calculated from the ENTIRE downline, so this must be complete or must fail. If the
 * safety ceiling is reached it throws DownlineLimitExceededError rather than returning what it
 * found: a partial tree accepted as complete would silently understate a reward base, and
 * nothing downstream could detect it.
 *
 * Children are fetched in pages so memory stays bounded while the RESULT never is.
 */
export async function walkDownline(
  leaderUserId: string,
  visit: (node: { userId: string; relativeDepth: number }) => void | Promise<void>,
  options: { maxNodes?: number } = {},
): Promise<{ visited: number; maxDepth: number }> {
  const limit = options.maxNodes ?? DOWNLINE_MAX_NODES;
  const seen = new Set<string>([leaderUserId]);

  let frontier: string[] = [leaderUserId];
  let depth = 0;
  let visited = 0;
  let maxDepth = 0;

  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];

    for (let i = 0; i < frontier.length; i += DOWNLINE_PAGE_SIZE) {
      const parents = frontier.slice(i, i + DOWNLINE_PAGE_SIZE);
      const children = await User.find(
        { referredByUserId: { $in: parents } },
        { userId: 1 },
      ).lean();

      for (const child of children) {
        const childId = child.userId as string;
        if (seen.has(childId)) continue;   // corruption guard; a tree has no repeats
        seen.add(childId);

        visited += 1;
        if (visited > limit) throw new DownlineLimitExceededError(leaderUserId, visited, limit);

        maxDepth = depth;
        await visit({ userId: childId, relativeDepth: depth });
        next.push(childId);
      }
    }

    frontier = next;
  }

  return { visited, maxDepth };
}

/** Counts descendants per relative depth. Complete or throws, like walkDownline. */
export async function getDownlineCountsByDepth(
  leaderUserId: string,
  maxDepth: number = LEVEL_INCOME_MAX_DEPTH,
): Promise<Record<number, number>> {
  const counts: Record<number, number> = {};
  await walkDownline(leaderUserId, ({ relativeDepth }) => {
    if (relativeDepth <= maxDepth) counts[relativeDepth] = (counts[relativeDepth] ?? 0) + 1;
  });
  for (let d = 1; d <= maxDepth; d++) counts[d] ??= 0;
  return counts;
}

export interface TreeNode {
  userId: string;
  /**
   * The protocol identity, and what the UI labels people by. Always present: a member is in the
   * tree only once they have registered with it. A referral code is an INVITE token: useful for
   * your own sharing, meaningless as a name for someone else, and not yours to publish.
   */
  externalEOA: string;
  referralCode: string;
  /** Null for the viewer themselves, the root of the returned subtree. */
  parentUserId: string | null;
  /** Depth RELATIVE to the viewer: 1 is a direct referral. */
  relativeDepth: number;
  directReferralCount: number;
  joinedAt: string;
}

/**
 * The viewer's downline as a bounded tree, for display.
 *
 * Deliberately depth-limited and node-capped, unlike walkDownline: this feeds a screen, and a
 * leader with a large network must not be able to make one HTTP response unbounded. It is a
 * VIEW, never a reward input — Rank reads walkDownline, which is complete or throws.
 *
 * `truncated` says plainly when there is more below, so the UI can never imply the tree ends
 * where the response does.
 */
export async function getDownlineTree(
  viewerUserId: string,
  options: { maxDepth?: number; maxNodes?: number } = {},
): Promise<{ nodes: TreeNode[]; truncated: boolean; maxDepth: number }> {
  const maxDepth = Math.min(Math.max(options.maxDepth ?? 3, 1), 7);
  const maxNodes = Math.min(Math.max(options.maxNodes ?? 200, 1), 500);

  const nodes: TreeNode[] = [];
  const seen = new Set<string>([viewerUserId]);
  let frontier = [viewerUserId];
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !truncated; depth++) {
    const children = await User.find(
      { referredByUserId: { $in: frontier } },
      { userId: 1, referralCode: 1, externalEOA: 1, referredByUserId: 1, createdAt: 1 },
    ).sort({ createdAt: 1 }).lean();

    const next: string[] = [];
    for (const child of children) {
      const childId = child.userId as string;
      if (seen.has(childId)) continue;            // corruption guard
      if (nodes.length >= maxNodes) { truncated = true; break; }
      seen.add(childId);
      nodes.push({
        userId: childId,
        externalEOA: child.externalEOA as string,
        referralCode: child.referralCode as string,
        parentUserId: child.referredByUserId as string,
        relativeDepth: depth,
        directReferralCount: 0,                   // filled below in one query
        joinedAt: (child.createdAt as Date).toISOString(),
      });
      next.push(childId);
    }

    // More levels exist below the cut-off; say so rather than implying the tree ends here.
    if (!truncated && depth === maxDepth && next.length > 0) {
      truncated = (await User.countDocuments({ referredByUserId: { $in: next } })) > 0;
    }
    frontier = next;
  }

  // One grouped count instead of a query per node.
  if (nodes.length > 0) {
    const counts = await User.aggregate<{ _id: string; n: number }>([
      { $match: { referredByUserId: { $in: nodes.map((n) => n.userId) } } },
      { $group: { _id: "$referredByUserId", n: { $sum: 1 } } },
    ]);
    const by = new Map(counts.map((c) => [c._id, c.n]));
    for (const node of nodes) node.directReferralCount = by.get(node.userId) ?? 0;
  }

  return { nodes, truncated, maxDepth };
}

export interface ReferralSummary {
  userId: string;
  referralCode: string;
  /** The sponsor's code, not their wallet or EOA. Enough to identify, nothing private. */
  sponsor: { userId: string; referralCode: string } | null;
  isRoot: boolean;
  /** Every direct referral. */
  directReferralCount: number;
  /** Directs who qualify this user for Level unlock and the Rank direct requirement. */
  qualifyingDirectCount: number;
}

/** Everything the authenticated user's own referral page needs, in one read. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const user = await User.findOne({ userId });
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "User no longer exists.");

  const [sponsor, standing] = await Promise.all([
    getSponsor(userId),
    getDirectReferralStanding(userId),
  ]);

  return {
    userId: user.userId,
    referralCode: user.referralCode,
    sponsor: sponsor ? { userId: sponsor.userId, referralCode: sponsor.referralCode } : null,
    isRoot: user.referredByUserId === null || user.referredByUserId === undefined,
    directReferralCount: standing.total,
    qualifyingDirectCount: standing.qualifying,
  };
}
