import fs from 'fs';
import path from 'path';
import { Wallet, ethers } from 'ethers';
import readline from 'readline';
import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { blake2AsU8a, encodeAddress } from '@polkadot/util-crypto';
import { hexToU8a, stringToU8a } from '@polkadot/util';

// dynamic chalk loader to avoid ESM import issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chalk: any;

const loadChalk = async (): Promise<any> => {
  if (!chalk) chalk = (await import('chalk')).default;
  return chalk;
};

type CliArgs = {
  'private-key'?: string;
  mnemonic?: string;
};

const argv = yargs(hideBin(process.argv))
  .option('private-key', {
    alias: 'p',
    type: 'string',
    description: 'Provide an existing private key',
    conflicts: 'mnemonic',
  })
  .option('mnemonic', {
    alias: 'm',
    type: 'string',
    description: 'Provide an existing mnemonic phrase',
    conflicts: 'private-key',
  })
  .help()
  .alias('help', 'h')
  .parseSync() as unknown as CliArgs;

const prompt = (q: string): Promise<string> =>
  new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, a => {
      rl.close();
      resolve(a);
    });
  });

// Environment variables are loaded via 'dotenv/config' import above

async function intro(): Promise<boolean> {
  const c = await loadChalk();
  const msg = `${c.cyanBright('This script will create an EVM compatible Bittensor account.')}

${c.gray('This account is just used to interact with the SN77\'s Contract.\nThis should be a different account from the registered miner.')}

Continue? [Y/n] `;
  const answer = (await prompt(msg)).trim().toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

async function main(): Promise<[void, Error | null]> {
  if (!(await intro())) return [undefined, null];
  
  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  let mnemonic: string | null = null;

  try {
    if (argv['private-key']) {
      wallet = new Wallet(argv['private-key']);
    } else if (argv.mnemonic) {
      wallet = Wallet.fromPhrase(argv.mnemonic);
      mnemonic = argv.mnemonic;
    } else {
      wallet = Wallet.createRandom();
      mnemonic = wallet.mnemonic?.phrase ?? null;
    }
  } catch (err) {
    return [undefined, err as Error];
  }

  const privateKey = wallet.privateKey;
  const address = wallet.address;

  let ss58Address = '';
  try {
    const prefix = stringToU8a('evm:');
    const addrBytes = hexToU8a(address);
    const combined = new Uint8Array(prefix.length + addrBytes.length);
    combined.set(prefix);
    combined.set(addrBytes, prefix.length);
    const substrateId = blake2AsU8a(combined);
    ss58Address = encodeAddress(substrateId, 42);
  } catch {}

  const c = await loadChalk();
  console.log(c.greenBright('\nWallet Details'));
  console.log(`${c.blue('EVM Address:')} ${c.yellowBright(address)}`);
  if (ss58Address) console.log(`${c.blue('SS58 Address:')} ${c.yellowBright(ss58Address)}`);
  console.log('');

  const keysDir = path.join(process.cwd(), '.keys');
  fs.mkdirSync(keysDir, { recursive: true });

  const keyPath = path.join(keysDir, `key-${address}.json`);
  fs.writeFileSync(
    keyPath,
    JSON.stringify({ address, privateKey, mnemonic, ss58Address: ss58Address || null }, null, 2)
  );
  console.log(`key saved to ${keyPath}\n`);

  const existing = process.env.ETH_PRIVKEY;
  let shouldUpdateEnv = true;
  
  if (existing) {
    const yn = (await prompt('A private key already exists in .env, update with new key? [y/N]: ')).trim().toLowerCase();
    shouldUpdateEnv = yn === 'y' || yn === 'yes';
  } else {
    const yn = (await prompt('Update .env file with new credentials? [Y/n]: ')).trim().toLowerCase();
    shouldUpdateEnv = yn === '' || yn === 'y' || yn === 'yes';
  }

  if (shouldUpdateEnv) {
    const envPath = path.join(process.cwd(), '.env');
    let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const upd = (key: string, val: string | undefined): void => {
      if (!val) return;
      const regex = new RegExp(`${key}=.*(?:\r?\n|$)`, 'i');
      env = regex.test(env) ? env.replace(regex, `${key}=${val}\n`) : `${env}${key}=${val}\n`;
    };
    upd('ETH_PRIVKEY', privateKey);
    upd('ADDRESS', address);
    if (ss58Address) upd('SS58_ADDRESS', ss58Address);
    fs.writeFileSync(envPath, env.trim() + '\n');
    console.log((await loadChalk()).gray('.env updated'));
  } else {
    console.log((await loadChalk()).gray('.env not updated'));
  }

  const c2 = await loadChalk();
  console.log('\n' + c2.cyanBright(' -- Next steps --') + c2.cyanBright('\nFund the wallet with a small amount of TAO for gas fees (e.g., 0.02 TAO)\nThen you can run the following commands:') + "\n");
  console.log(c2.magenta('bunx tsx scripts/register.ts') + c2.gray(' # Link an Ethereum Wallet to a Miner'));
  console.log(c2.magenta('bunx tsx scripts/vote.ts') + c2.gray(' # Vote for Liquidity Pools') + '\n');

  return [undefined, null];
}

(async () => {
  const [, err] = await main();
  if (err) {
    console.error('error:', err.message);
    process.exit(1);
  }
})(); 