import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import Table from 'cli-table3';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { ApiHolder, ApiMiner, ApiVote, LiquidityPosition } from '../utils/liquidityTypes';
import { computeWeightsFromInputs, getAllVotedPoolAddresses } from '../utils/weightCalculation';
import { getMinerLiquidityPositions } from '../utils/uniswapGraph';
import { ensureGraphApiKey, isYes, prompt } from '../utils/verifyWeightsSetup';

dotenv.config();

const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://77.creativebuilds.io';
const TRUNC_LEN = 7;
const DRIFT_NOTE = 'Server weights are recalculated every ~5 minutes; drift may accumulate between refreshes and live tick movement.';

type ApiResp<T> = { success: boolean; error?: string } & T;
type VerifyArgv = { 'use-api-positions': boolean; 'no-setup': boolean };
type WeightRow = { hotkey: string; local: number; server: number; difference: number };

const fetchJson = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${PRODUCTION_URL}${path}`);
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  const data = await r.json() as ApiResp<T>;
  if (!data.success) throw new Error(data.error || `${path} failed`);
  return data;
};

const truncateHotkey = (hotkey: string) => hotkey.length <= TRUNC_LEN ? hotkey : `${hotkey.slice(0, TRUNC_LEN)}...`;

const buildWeightRows = (local: Record<string, number>, api: Record<string, number>): WeightRow[] => {
  const keys = new Set([...Object.keys(local), ...Object.keys(api)]);
  const rows: WeightRow[] = [];
  for (const hotkey of keys) {
    const lv = local[hotkey] ?? 0;
    const sv = api[hotkey] ?? 0;
    rows.push({ hotkey, local: lv, server: sv, difference: Math.abs(lv - sv) });
  }
  return rows.sort((a, b) => b.server - a.server || b.local - a.local || a.hotkey.localeCompare(b.hotkey));
};

const printWeightTable = (rows: WeightRow[]) => {
  const table = new Table({ head: ['hotkey', 'local', 'server', 'difference'], style: { head: [], border: [] } });
  for (const r of rows) table.push([truncateHotkey(r.hotkey), r.local.toFixed(8), r.server.toFixed(8), r.difference.toFixed(8)]);
  console.log(table.toString());
};

const saveWeightTable = async (rows: WeightRow[], filePath: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = ['hotkey,local,server,difference', ...rows.map(r => `${r.hotkey},${r.local},${r.server},${r.difference}`)];
  await fs.writeFile(filePath, `${lines.join('\n')}\n`);
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

  const rows = buildWeightRows(localWeights, apiWeights);
  const localNonZero = rows.filter(r => r.local > 0).length;
  const apiNonZero = rows.filter(r => r.server > 0).length;
  console.log(`\nComputed ${rows.length} miner weights (${localNonZero} non-zero local, ${apiNonZero} non-zero server)\n`);
  printWeightTable(rows);
  console.log(`\n${DRIFT_NOTE}`);

  const saveAnswer = process.stdin.isTTY ? await prompt('\nSave full results to file? [Y/n] ') : 'n';
  if (!isYes(saveAnswer)) return 0;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(process.cwd(), 'logs', `verify-weights-${ts}.csv`);
  await saveWeightTable(rows, filePath);
  console.log(`Saved to ${filePath}`);
  return 0;
};

async function main(): Promise<number> {
  const argv = yargs(hideBin(process.argv))
    .option('use-api-positions', { type: 'boolean', default: false, describe: 'Use /positions from API instead of The Graph (less independent)' })
    .option('no-setup', { type: 'boolean', default: false, describe: 'Skip interactive setup; fail if THEGRAPH_API_KEY is missing' })
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
