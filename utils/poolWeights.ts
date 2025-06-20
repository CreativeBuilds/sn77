import { encodeAddress } from '@polkadot/util-crypto';
import { getAddress } from 'ethers';
import dotenv from 'dotenv';    
import fs from 'fs';
import path from 'path';

const NO_ENV = process.env.NO_ENV === 'true';

if (NO_ENV) {
  let _env: Record<string, string> = {};
  Object.keys(process.env).forEach(key => {
      _env[key] = process.env[key] ?? '';
      delete process.env[key];
    });

  dotenv.config();

  let _env2: Record<string, string> = {};
  Object.keys(process.env).forEach(key => {
      _env2[key] = process.env[key] ?? '';
      delete process.env[key];
    });

  process.env = {..._env2, PYTHONPATH: _env.PYTHONPATH, PATH: _env.PATH};
} else {
  dotenv.config();
}

// Standard [value, err] tuple type
export type Result<T> = [T, Error | null];

export interface VotePosition { poolAddress: string; weight: number; }
export interface Balance { address: string; balance: number; }

const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

/**
 * Fetch vote positions from centralized votes server.
 */
export async function fetchVotePositions(): Promise<Result<Record<string, VotePosition[]>>> {
    try {
        const votesServerUrl = process.env.VOTES_SERVER_URL || 'http://localhost:3000';
        if (!votesServerUrl) return [{}, new Error('VOTES_SERVER_URL not configured')];

        const resp = await fetch(`${votesServerUrl}/allVotes`);
        const txt = await resp.text();
        if (!resp.ok) return [{}, new Error(`Votes server request failed (${resp.status}): ${txt}`)];
        
        const js = JSON.parse(txt);
        if (!js.success) return [{}, new Error(`Votes server error: ${js.error || 'Unknown error'}`)];
        
        const votes = js.votes || [];
        const map: Record<string, VotePosition[]> = {};
        
        for (const vote of votes) {
            if (!vote.ss58Address || !vote.pools) continue;
            
            const ss58 = vote.ss58Address;
            if (!map[ss58]) map[ss58] = [];
            
            for (const pool of vote.pools) {
                if (!pool.address || typeof pool.weight !== 'number') continue;
                if (!isFinite(pool.weight) || pool.weight <= 0) continue;
                
                let poolAddress: string;
                try { poolAddress = getAddress(pool.address); } catch { continue; }
                
                map[ss58].push({ poolAddress, weight: pool.weight });
            }
        }
   
        return [map, null];
    } catch (err) {
        return [{}, err instanceof Error ? err : new Error(String(err))];
    }
}

/**
 * Fetch balances for addresses from votes server's /allHolders endpoint.
 */
export async function fetchBalances(votePositions: Record<string, VotePosition[]>): Promise<Result<Record<string, Balance>>> {
    const addresses = Object.keys(votePositions);
    if (!addresses.length) return [{}, null];

    try {
        const votesServerUrl = process.env.VOTES_SERVER_URL || 'http://localhost:3000';

        const resp = await fetch(`${votesServerUrl}/allHolders`);
        const txt = await resp.text();
        if (!resp.ok) return [{}, new Error(`Holders server request failed (${resp.status}): ${txt}`)];
        
        const js = JSON.parse(txt);
        if (!js.success) return [{}, new Error(`Holders server error: ${js.error || 'Unknown error'}`)];
        
        const holders = js.holders || [];
        const mapAll = new Map<string, number>();
        
        for (const holder of holders) {
            if (!holder.address || !holder.alphaBalanceRaw) continue;
            
            const rawBalance = parseFloat(holder.alphaBalanceRaw);
            if (!isNaN(rawBalance)) {
                const alphaTokens = rawBalance / 1e9;
                mapAll.set(holder.address, alphaTokens);
            }
        }

        const relevant: Record<string, Balance> = {};
        for (const a of addresses) relevant[a] = { address: a, balance: mapAll.get(a) ?? 0 };

        return [relevant, null];
    } catch (err) {
        return [{}, err instanceof Error ? err : new Error(String(err))];
    }
}

/**
 * Calculate pool weights (normalized) and also return raw weights.
 */
export function calculatePoolWeights(
    positions: Record<string, VotePosition[]>,
    balances: Record<string, Balance>
): [Record<string, number>, Record<string, number>] {
    const raw: Record<string, number> = {};
    for (const addr in positions) {
        const bal = balances?.[addr]?.balance ?? 0;
        if (!isFinite(bal) || bal <= 0) continue;
        const userPositions = positions[addr] ?? [];
        if (!userPositions.length) continue;
        const total = userPositions.reduce((s, p) => {
            const weight = isFinite(p.weight) ? p.weight : 0;
            return s + weight;
        }, 0);
        if (!isFinite(total) || total <= 0) continue;
        for (const p of userPositions) {
            if (!isFinite(p.weight) || p.weight < 0) continue;
            let key: string;
            try { key = getAddress(p.poolAddress); } catch { continue; }
            if (!raw[key]) raw[key] = 0;
            const contribution = (p.weight / total) * bal;
            if (isFinite(contribution)) raw[key] += contribution;
        }
    }
    const sum = Object.values(raw).reduce((s, v) => s + v, 0);
    const normalized: Record<string, number> = {};
    if (isFinite(sum) && sum > 0) {
        for (const k in raw) {
            const normalizedWeight = raw[k] / sum;
            if (isFinite(normalizedWeight)) normalized[k] = normalizedWeight;
        }
    }
    return [normalized, raw];
}

/**
 * High level helper returning [normalized, raw, error]
 */
export async function computePoolWeights(): Promise<[[Record<string, number>, Record<string, number>], Error | null]> {
    const [positions, posErr] = await fetchVotePositions();
    console.log('positions:', positions);
    if (posErr) return [[{}, {}], posErr];
    const [balances, balErr] = await fetchBalances(positions);
    console.log('balances:', balances);
    if (balErr) return [[{}, {}], balErr];
    return [calculatePoolWeights(positions, balances), null];
} 