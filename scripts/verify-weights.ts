import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { ApiHolder, ApiMiner, ApiVote, LiquidityPosition } from '../utils/liquidityTypes';
import { computeWeightsFromInputs, getAllVotedPoolAddresses } from '../utils/weightCalculation';
import { getMinerLiquidityPositions } from '../utils/uniswapGraph';
import { ensureGraphApiKey } from '../utils/verifyWeightsSetup';

dotenv.config();

const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://77.creativebuilds.io';
const DEFAULT_REL_TOLERANCE = Number(process.env.VERIFY_REL_TOLERANCE || 0.02);
const DEFAULT_ABS_TOLERANCE = Number(process.env.VERIFY_ABS_TOLERANCE || 1e-5);

type ApiResp<T> = { success: boolean; error?: string } & T;
type VerifyArgv = { tolerance: number; 'abs-tolerance': number; 'use-api-positions': boolean; top: number; 'no-setup': boolean };

const fetchJson = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${PRODUCTION_URL}${path}`);
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  const data = await r.json() as ApiResp<T>;
  if (!data.success) throw new Error(data.error || `${path} failed`);
  return data;
};

const compareWeights = (
  local: Record<string, number>,
  api: Record<string, number>,
  relTolerance: number,
  absTolerance: number,
) => {
  const keys = new Set([...Object.keys(local), ...Object.keys(api)]);
  const mismatches: Array<{ hotkey: string; local: number; api: number; diff: number; relDiff: number }> = [];
  let comparedNonZero = 0;
  let matched = 0;
  for (const hotkey of keys) {
    const l = local[hotkey] ?? 0;
    const a = api[hotkey] ?? 0;
    const diff = Math.abs(l - a);
    const base = Math.max(Math.abs(a), Math.abs(l), absTolerance);
    const relDiff = diff / base;
    if (l > absTolerance || a > absTolerance) comparedNonZero++;
    const ok = diff <= absTolerance || relDiff <= relTolerance;
    if (ok) { matched++; continue; }
    mismatches.push({ hotkey, local: l, api: a, diff, relDiff });
  }
  mismatches.sort((x, y) => y.diff - x.diff);
  return { mismatches, comparedNonZero, matched, totalKeys: keys.size };
};

const stripEmission = (positions: Record<string, (LiquidityPosition & { emission?: number })[]>): Record<string, LiquidityPosition[]> => {
  const out: Record<string, LiquidityPosition[]> = {};
  for (const [miner, list] of Object.entries(positions)) out[miner] = list.map(({ emission: _e, token0Amount: _a, token1Amount: _b, usdValue: _u, ...rest }) => rest);
  return out;
};

const runVerification = async (graphKey: string, argv: VerifyArgv): Promise<number> => {
  console.log(`Fetching inputs from ${PRODUCTION_URL}...`);
  const [votesData, holdersData, minersData, weightsData] = await Promise.all([
    fetchJson<{ votes: ApiVote[]; totalAlphaTokens: number; cached?: boolean }>('/allVotes'),
    fetchJson<{ holders: ApiHolder[]; cached?: boolean }>('/allHolders'),
    fetchJson<{ miners: ApiMiner[]; linkedMiners: number; cached?: boolean }>('/allMiners'),
    fetchJson<{ weights: Record<string, number>; cached?: boolean }>('/weights'),
  ]);

  const votes = votesData.votes || [];
  const holders = holdersData.holders || [];
  const apiWeights = weightsData.weights || {};
  const minerAddresses: Record<string, string> = {};
  for (const m of minersData.miners || []) if (m.ethereumAddress) minerAddresses[m.hotkeyAddress] = m.ethereumAddress;

  const poolAddresses = getAllVotedPoolAddresses(votes);
  console.log(`Votes: ${votes.length}, holders: ${holders.length}, linked miners: ${Object.keys(minerAddresses).length}, pools: ${poolAddresses.length}`);
  console.log(`API weights cached: ${weightsData.cached ?? false}`);

  let rawPositions: Record<string, LiquidityPosition[]>;
  if (argv['use-api-positions']) {
    const posData = await fetchJson<{ positions: Record<string, LiquidityPosition[]>; cached?: boolean }>('/positions');
    console.log(`Using API positions (cached: ${posData.cached ?? false})`);
    rawPositions = stripEmission(posData.positions || {});
    for (const uid of Object.keys(minerAddresses)) if (!rawPositions[uid]) rawPositions[uid] = [];
  } else {
    console.log('Fetching positions from The Graph...');
    const [positions, posErr] = await getMinerLiquidityPositions(minerAddresses, poolAddresses, graphKey);
    if (posErr) { console.error('Graph fetch failed:', posErr.message); return 1; }
    rawPositions = positions;
  }

  const [localWeights, weightErr] = computeWeightsFromInputs(votes, holders, rawPositions);
  if (weightErr) { console.error('Local weight calculation failed:', weightErr.message); return 1; }

  const localNonZero = Object.values(localWeights).filter(w => w > 0).length;
  const apiNonZero = Object.values(apiWeights).filter(w => w > 0).length;
  console.log(`Computed ${Object.keys(localWeights).length} miner weights (${localNonZero} non-zero); API has ${Object.keys(apiWeights).length} (${apiNonZero} non-zero)`);

  const { mismatches, comparedNonZero, matched, totalKeys } = compareWeights(localWeights, apiWeights, argv.tolerance, argv['abs-tolerance']);

  const topLocal = Object.entries(localWeights).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topApi = Object.entries(apiWeights).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('\nTop local weights:');
  for (const [hk, w] of topLocal) console.log(`  ${hk.slice(0, 12)}... ${w.toFixed(8)}  (api: ${(apiWeights[hk] ?? 0).toFixed(8)})`);
  console.log('Top API weights:');
  for (const [hk, w] of topApi) console.log(`  ${hk.slice(0, 12)}... ${w.toFixed(8)}  (local: ${(localWeights[hk] ?? 0).toFixed(8)})`);

  if (!mismatches.length) {
    console.log(`\n✓ Verification passed (${matched}/${totalKeys} keys within tolerance; rel<=${argv.tolerance}, abs<=${argv['abs-tolerance']})`);
    console.log('Note: small drift is expected from ~1-5m server cache and live tick movement.');
    return 0;
  }

  console.log(`\n✗ ${mismatches.length} miner(s) outside tolerance (rel<=${argv.tolerance}, abs<=${argv['abs-tolerance']})`);
  for (const m of mismatches.slice(0, argv.top)) console.log(`  ${m.hotkey.slice(0, 16)}... local=${m.local.toFixed(8)} api=${m.api.toFixed(8)} diff=${m.diff.toFixed(8)} rel=${(m.relDiff * 100).toFixed(2)}%`);
  if (mismatches.length > argv.top) console.log(`  ... and ${mismatches.length - argv.top} more`);
  console.log(`Matched ${matched}/${totalKeys} keys; ${comparedNonZero} had non-zero weight on either side.`);
  console.log('Tips: retry in a few minutes; use --use-api-positions to isolate Graph vs formula drift.');
  return 1;
};

async function main(): Promise<number> {
  const argv = yargs(hideBin(process.argv))
    .option('tolerance', { type: 'number', default: DEFAULT_REL_TOLERANCE, describe: 'Max relative diff per miner (e.g. 0.02 = 2%)' })
    .option('abs-tolerance', { type: 'number', default: DEFAULT_ABS_TOLERANCE, describe: 'Absolute diff treated as match' })
    .option('use-api-positions', { type: 'boolean', default: false, describe: 'Use /positions from API instead of The Graph (less independent)' })
    .option('no-setup', { type: 'boolean', default: false, describe: 'Skip interactive setup; fail if THEGRAPH_API_KEY is missing' })
    .option('top', { type: 'number', default: 10, describe: 'How many mismatches to print' })
    .help().parseSync() as VerifyArgv;

  let graphKey = process.env.THEGRAPH_API_KEY || '';
  if (!argv['use-api-positions'] && !graphKey) {
    const [key, setupErr] = await ensureGraphApiKey(graphKey, argv['no-setup']);
    if (setupErr) { console.error(setupErr.message); return 1; }
    graphKey = key;
  }
  if (!argv['use-api-positions'] && !graphKey) { console.error('THEGRAPH_API_KEY is required unless --use-api-positions is set'); return 1; }
  return runVerification(graphKey, argv);
}

main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
