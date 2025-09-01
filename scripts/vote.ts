import {
  sr25519PairFromSeed,
  sr25519Sign,
  encodeAddress,
  cryptoWaitReady,
} from '@polkadot/util-crypto';
import { u8aToHex, hexToU8a } from '@polkadot/util';
import { fetchCurrentBittensorBlock, closeBittensorConnection } from '../utils/bittensorUtils';
import { formatAddress, normalizePoolWeights, Pool } from '../utils/poolUtils';
import { searchPools } from '../utils/poolSearchUtils';
import * as readline from 'readline';

const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://77.creativebuilds.io';
const MAX_POOLS = 10;

async function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function getPoolsFromUser(retractMode: boolean = false): Promise<[Pool[], string | null]> {
  if (retractMode) return [[], null];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const pools: Pool[] = [];
  let continueAdding = true;

  try {
    while (continueAdding && pools.length < MAX_POOLS) {
      console.log(`\nPool ${pools.length + 1} (${MAX_POOLS} Max)`);
      
      const searchQuery = await askQuestion(rl, 'Enter pool address or search query: ');
      const [searchResults, searchErr] = await searchPools(searchQuery);
      
      if (searchErr) {
        console.error('Error searching pools:', searchErr);
        continue;
      }

      if (searchResults.length === 0) {
        console.log('No pools found. Please try a different search.');
        continue;
      }

      console.log('\nSearch Results:');
      searchResults.forEach((pool: Pool, index: number) => {
        const tokenInfo = pool.token0Symbol && pool.token1Symbol 
          ? ` (${pool.token0Symbol}/${pool.token1Symbol})`
          : '';
        const feeInfo = pool.fee ? ` [${pool.fee/10000}%]` : '';
        console.log(`${index + 1}. ${formatAddress(pool.address)}${tokenInfo}${feeInfo}`);
      });

      const selection = await askQuestion(rl, 'Select pool number (or press Enter to search again): ');
      if (!selection) continue;

      const selectedIndex = parseInt(selection) - 1;
      if (selectedIndex < 0 || selectedIndex >= searchResults.length) {
        console.log('Invalid selection. Please try again.');
        continue;
      }

      const selectedPool = searchResults[selectedIndex];

      const weightStr = await askQuestion(rl, 'Enter weight (1-10000): ');
      const weight = parseInt(weightStr);
      
      if (isNaN(weight) || weight <= 0 || weight > 10000) {
        console.log('Invalid weight. Please enter a number between 1 and 10000.');
        continue;
      }

      pools.push({
        address: selectedPool.address,
        weight,
        token0: selectedPool.token0,
        token1: selectedPool.token1,
        token0Symbol: selectedPool.token0Symbol,
        token1Symbol: selectedPool.token1Symbol
      });

      if (pools.length < MAX_POOLS) {
        const addMore = await askQuestion(rl, 'Add another pool? (y/n): ');
        continueAdding = addMore.toLowerCase() === 'y';
      }
    }

    // Normalize weights to sum to 10000
    const totalWeight = pools.reduce((sum, pool) => sum + pool.weight, 0);
    const normalizedPools = pools.map(pool => ({
      ...pool,
      weight: Math.round((pool.weight / totalWeight) * 10000)
    }));

    // Ensure the last pool's weight makes the total exactly 10000
    if (normalizedPools.length > 0) {
      const currentTotal = normalizedPools.reduce((sum, pool) => sum + pool.weight, 0);
      normalizedPools[normalizedPools.length - 1].weight += (10000 - currentTotal);
    }

    return [normalizedPools, null];
  } finally {
    rl.close();
  }
}

async function submitVotes(retractMode: boolean = false) {
  await cryptoWaitReady();

  const privateKeyHex = process.env.HOLDER_COLDKEY;
  if (!privateKeyHex) {
    console.error('Error: HOLDER_COLDKEY environment variable is required');
    process.exit(1);
  }

  if (!privateKeyHex.startsWith('0x')) {
    console.error('Error: HOLDER_COLDKEY must be a hex string starting with 0x');
    process.exit(1);
  }

  const [currentBlock, blockErr] = await fetchCurrentBittensorBlock();
  if (blockErr) {
    console.error('Error: Failed to fetch current block:', blockErr);
    process.exit(1);
  }

  const seed = hexToU8a(privateKeyHex);
  const coldkeyPair = sr25519PairFromSeed(seed);
  const coldkeyAddress = encodeAddress(coldkeyPair.publicKey, 42);

  if (retractMode) {
    console.log('Retracting all votes...');
  } else {
    console.log('Generating vote submission...');
  }
  console.log('Coldkey Address:', coldkeyAddress);
  console.log('Current Block:', currentBlock);

  const [pools, poolsErr] = await getPoolsFromUser(retractMode);
  if (poolsErr) {
    console.error('Error:', poolsErr);
    process.exit(1);
  }

  const poolsStr = pools.map(pool => `${pool.address},${pool.weight}`).join(';');
  const votesMessage = `${poolsStr}|${currentBlock}`;

  if (retractMode) {
    console.log('\nRetracting all votes (empty allocation)');
  } else {
    console.log('\nPool Allocations:');
    pools.forEach((pool: Pool, index: number) => {
      const tokenInfo = pool.token0Symbol && pool.token1Symbol 
        ? ` (${pool.token0Symbol}/${pool.token1Symbol})`
        : '';
      console.log(`Pool ${index + 1}: ${formatAddress(pool.address)}${tokenInfo} (weight: ${pool.weight})`);
    });
    console.log('Total Weight:', pools.reduce((sum, pool) => sum + pool.weight, 0));
  }

  const coldkeySignatureBytes = sr25519Sign(votesMessage, coldkeyPair);
  const coldkeySignatureHex = u8aToHex(coldkeySignatureBytes);

  try {
    const response = await fetch(`${PRODUCTION_URL}/updateVotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: coldkeyAddress,
        message: votesMessage,
        signature: coldkeySignatureHex
      })
    });

    const result = await response.json();
    console.log('\nResponse:', result);

    if (!result.success) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    if (retractMode) {
      console.log('\nSuccessfully retracted all votes!');
    } else {
      console.log('\nSuccessfully submitted votes!');
    }
  } catch (error) {
    console.error('Error making request:', error);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const retractMode = args.includes('--retract') || args.includes('-r');

if (args.length > 0 && !retractMode) {
  console.error('Error: Invalid arguments');
  console.error('Usage: HOLDER_COLDKEY=0x... bun run submitVotes [--retract|-r]');
  console.error('  --retract, -r: Retract all votes (send empty allocation)');
  process.exit(1);
}

submitVotes(retractMode)
  .then(async () => {
    await closeBittensorConnection();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Error:', error);
    await closeBittensorConnection();
    process.exit(1);
  }); 