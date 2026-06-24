export interface LiquidityPosition {
  id: string;
  owner: string;
  liquidity: string;
  depositedToken0: string;
  depositedToken1: string;
  tickLower: { id: string; tickIdx: string };
  tickUpper: { id: string; tickIdx: string };
  token0: { id: string; symbol: string; name: string; decimals: string };
  token1: { id: string; symbol: string; name: string; decimals: string };
  pool: { id: string; feeTier: string; tick: string; token0Price: string; token1Price: string };
}

export interface VotePool { address: string; weight: number }
export interface ApiVote {
  ss58Address: string;
  pools: VotePool[];
  alphaBalance?: number;
  weightMultiplier?: number;
}
export interface ApiHolder { address: string; alphaBalanceRaw: string }
export interface ApiMiner { hotkeyAddress: string; ethereumAddress: string | null }
