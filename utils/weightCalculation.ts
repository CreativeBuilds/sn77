import type { ApiHolder, ApiVote, LiquidityPosition } from './liquidityTypes';

export type Result<T> = [T, Error | null];

export const VOTE_WEIGHT_TOTAL = 10000;
export const GAUSSIAN_AMPLITUDE = 10;
export const LIQUIDITY_NORMALIZATION_FACTOR = 1e9;
export const WEIGHT_ZERO_THRESHOLD = 1e-9;
export const FEE_TIER_STD_DEVS: Record<string, number> = {
  '100': 10, '500': 50, '3000': 200, '10000': 500,
};
export const DEFAULT_STD_DEV = FEE_TIER_STD_DEVS['3000'];

export const isValidPosition = (position: LiquidityPosition): boolean => {
  if (!position.pool) return false;
  const currentTick = Number(position.pool.tick);
  if (!Number.isFinite(currentTick)) return false;
  const tickLower = Number(position.tickLower?.tickIdx);
  const tickUpper = Number(position.tickUpper?.tickIdx);
  if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper)) return false;
  if (tickLower >= tickUpper) return false;
  return currentTick > tickLower && currentTick < tickUpper;
};

export const gaussianScore = (distance: number, a = GAUSSIAN_AMPLITUDE, c = DEFAULT_STD_DEV): number => {
  if (c <= 0) return 0;
  return a * Math.exp(-(distance ** 2) / (2 * (c ** 2)));
};

export const calculatePositionScore = (position: LiquidityPosition, currentTick: number): number => {
  if (!position.pool || position.tickLower?.tickIdx == null || position.tickUpper?.tickIdx == null || position.liquidity == null) return 0;
  const tickLower = Number(position.tickLower.tickIdx);
  const tickUpper = Number(position.tickUpper.tickIdx);
  const liquidityRaw = Number(position.liquidity);
  if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper) || !Number.isFinite(liquidityRaw) || !Number.isFinite(currentTick)) return 0;
  if (tickLower >= tickUpper || currentTick <= tickLower || currentTick >= tickUpper) return 0;
  const stdDev = FEE_TIER_STD_DEVS[position.pool.feeTier] ?? DEFAULT_STD_DEV;
  const midPoint = (tickLower + tickUpper) / 2;
  const scoreLower = gaussianScore(Math.abs(currentTick - tickLower), GAUSSIAN_AMPLITUDE, stdDev);
  const scoreUpper = gaussianScore(Math.abs(currentTick - tickUpper), GAUSSIAN_AMPLITUDE, stdDev);
  const scoreMid = gaussianScore(Math.abs(currentTick - midPoint), GAUSSIAN_AMPLITUDE, stdDev);
  const averageGaussianMultiplier = (scoreLower + 4 * scoreMid + scoreUpper) / 6;
  return averageGaussianMultiplier * (liquidityRaw / LIQUIDITY_NORMALIZATION_FACTOR);
};

export const buildHolderMap = (holders: ApiHolder[]): Map<string, number> =>
  new Map(holders.map(h => [h.address, parseFloat(h.alphaBalanceRaw || '0')]));

export const getActivePoolAddresses = (votes: ApiVote[], holderMap: Map<string, number>): string[] => {
  const activePools = new Set<string>();
  for (const vote of votes) {
    if ((holderMap.get(vote.ss58Address) || 0) <= 0) continue;
    for (const pool of vote.pools) activePools.add(pool.address.toLowerCase());
  }
  return Array.from(activePools);
};

export const getAllVotedPoolAddresses = (votes: ApiVote[]): string[] => {
  const pools = new Set<string>();
  for (const vote of votes) for (const pool of vote.pools) pools.add(pool.address.toLowerCase());
  return Array.from(pools);
};

export const calculatePoolEmissions = (votes: ApiVote[], holderMap: Map<string, number>): Map<string, number> => {
  const validVotes = votes.filter(v => (holderMap.get(v.ss58Address) || 0) > 0);
  const totalAlpha = validVotes.reduce((sum, v) => sum + (holderMap.get(v.ss58Address) || 0), 0);
  const poolWeights = new Map<string, number>();
  for (const vote of validVotes) {
    const weightMultiplier = totalAlpha > 0 ? (holderMap.get(vote.ss58Address) || 0) / totalAlpha : 0;
    for (const pool of vote.pools) {
      const key = pool.address.toLowerCase();
      poolWeights.set(key, (poolWeights.get(key) || 0) + pool.weight * weightMultiplier);
    }
  }
  const emissionMap = new Map<string, number>();
  for (const [poolAddress, totalWeight] of poolWeights.entries()) emissionMap.set(poolAddress, totalWeight / VOTE_WEIGHT_TOTAL);
  return emissionMap;
};

export const calculateAndNormalizePoolScores = (minerLiquidityPositions: Record<string, LiquidityPosition[]>): Result<Record<string, number>> => {
  try {
    const poolRawScores: Record<string, Array<{ positionId: string; rawScore: number }>> = {};
    for (const positions of Object.values(minerLiquidityPositions)) {
      for (const pos of positions) {
        const poolId = pos.pool?.id;
        const currentTick = Number(pos.pool?.tick);
        if (!poolId || !Number.isFinite(currentTick)) continue;
        const rawScore = calculatePositionScore(pos, currentTick);
        if (!poolRawScores[poolId]) poolRawScores[poolId] = [];
        poolRawScores[poolId].push({ positionId: pos.id, rawScore });
      }
    }
    const normalizedPositionScores: Record<string, number> = {};
    for (const positionsInPool of Object.values(poolRawScores)) {
      const totalRawScoreInPool = positionsInPool.reduce((sum, p) => sum + p.rawScore, 0);
      for (const p of positionsInPool) normalizedPositionScores[p.positionId] = totalRawScoreInPool > 0 ? p.rawScore / totalRawScoreInPool : 0;
    }
    return [normalizedPositionScores, null];
  } catch (err) {
    return [{}, err instanceof Error ? err : new Error(String(err))];
  }
};

export const calculateFinalMinerWeights = (
  minerLiquidityPositions: Record<string, LiquidityPosition[]>,
  normalizedPositionScores: Record<string, number>,
  poolWeights: Record<string, number>,
): Result<Record<string, number>> => {
  try {
    const finalMinerWeights: Record<string, number> = {};
    for (const minerId of Object.keys(minerLiquidityPositions)) finalMinerWeights[minerId] = 0;
    for (const [minerId, positions] of Object.entries(minerLiquidityPositions)) {
      let minerTotalContribution = 0;
      for (const pos of positions) {
        const poolId = pos.pool?.id;
        if (!poolId) continue;
        minerTotalContribution += (normalizedPositionScores[pos.id] ?? 0) * (poolWeights[poolId.toLowerCase()] || 0);
      }
      finalMinerWeights[minerId] = minerTotalContribution;
    }
    let totalWeight = 0;
    for (const minerId in finalMinerWeights) {
      if (finalMinerWeights[minerId] < WEIGHT_ZERO_THRESHOLD) finalMinerWeights[minerId] = 0;
      totalWeight += finalMinerWeights[minerId];
    }
    if (totalWeight > 0) for (const minerId in finalMinerWeights) finalMinerWeights[minerId] /= totalWeight;
    return [finalMinerWeights, null];
  } catch (err) {
    return [{}, err instanceof Error ? err : new Error(String(err))];
  }
};

export const prepareMinerPositions = (
  rawPositions: Record<string, LiquidityPosition[]>,
  activePools: Set<string>,
): Record<string, LiquidityPosition[]> => {
  const out: Record<string, LiquidityPosition[]> = {};
  for (const [minerId, positions] of Object.entries(rawPositions)) {
    out[minerId] = (positions || []).filter(p => isValidPosition(p) && activePools.has(p.pool.id.toLowerCase()));
  }
  return out;
};

export const computeWeightsFromInputs = (
  votes: ApiVote[],
  holders: ApiHolder[],
  minerLiquidityPositions: Record<string, LiquidityPosition[]>,
): Result<Record<string, number>> => {
  const holderMap = buildHolderMap(holders);
  const activePools = new Set(getActivePoolAddresses(votes, holderMap));
  const positionsByMiner = prepareMinerPositions(minerLiquidityPositions, activePools);
  const poolEmissions = calculatePoolEmissions(votes, holderMap);
  const poolWeights: Record<string, number> = {};
  poolEmissions.forEach((value, key) => { poolWeights[key] = value; });
  const [normalizedPositionScores, normErr] = calculateAndNormalizePoolScores(positionsByMiner);
  if (normErr) return [{}, normErr];
  return calculateFinalMinerWeights(positionsByMiner, normalizedPositionScores, poolWeights);
};
