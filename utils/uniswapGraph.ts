import type { LiquidityPosition } from './liquidityTypes';

export type Result<T> = [T, Error | null];
const SUBGRAPH_ID = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
const GRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${SUBGRAPH_ID}`;
const POSITIONS_QUERY = `query($owners:[String!]!,$pools:[String!]!,$limit:Int!){positions(first:$limit,where:{owner_in:$owners,liquidity_gt:"1",pool_:{id_in:$pools}}){id owner liquidity depositedToken0 depositedToken1 tickLower{id tickIdx} tickUpper{id tickIdx} token0{id symbol name decimals} token1{id symbol name decimals} pool{id feeTier tick token0Price token1Price}}}`;

export const getMinerLiquidityPositions = async (
  minerAddresses: Record<string, string>,
  pools: string[],
  apiKey: string,
): Promise<Result<Record<string, LiquidityPosition[]>>> => {
  const ethAddresses = Object.values(minerAddresses);
  if (!ethAddresses.length) return [{}, null];
  if (!apiKey) return [{}, new Error('THEGRAPH_API_KEY not configured')];
  const poolIds = pools.map(p => p.toLowerCase());
  const addrToUid = new Map<string, string>();
  for (const [uid, addr] of Object.entries(minerAddresses)) addrToUid.set(addr.toLowerCase(), uid);
  const out: Record<string, LiquidityPosition[]> = {};
  for (const uid of Object.keys(minerAddresses)) out[uid] = [];
  const batchSize = 100;
  const limit = 1000;
  for (let i = 0; i < ethAddresses.length; i += batchSize) {
    const owners = ethAddresses.slice(i, i + batchSize).map(a => a.toLowerCase());
    const r = await fetch(GRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: POSITIONS_QUERY, variables: { owners, pools: poolIds, limit } }),
    });
    const txt = await r.text();
    if (!r.ok) return [{}, new Error(`Graph request failed (${r.status}): ${txt.slice(0, 200)}`)];
    const data = JSON.parse(txt) as { data?: { positions?: LiquidityPosition[] }; errors?: unknown[] };
    if (data.errors?.length) return [{}, new Error(`Graph errors: ${JSON.stringify(data.errors).slice(0, 300)}`)];
    for (const p of data.data?.positions ?? []) {
      const uid = addrToUid.get(p.owner.toLowerCase());
      if (!uid) continue;
      out[uid].push(p);
    }
  }
  return [out, null];
};
