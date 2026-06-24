import readline from 'readline';
import { upsertEnvVar } from './envFileUtils';

const GRAPH_KEYS_URL = 'https://thegraph.com/studio/apikeys/';
const GRAPH_DOCS_URL = 'https://thegraph.com/docs/en/subgraphs/querying/managing-api-keys/';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chalk: any;
const loadChalk = async () => { if (!chalk) chalk = (await import('chalk')).default; return chalk; };

export const prompt = (q: string): Promise<string> => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); resolve(a); });
});

export const isYes = (a: string) => { const s = a.trim().toLowerCase(); return s === '' || s === 'y' || s === 'yes'; };

export const ensureGraphApiKey = async (currentKey: string, noSetup: boolean): Promise<[string, Error | null]> => {
  if (currentKey) return [currentKey, null];
  if (noSetup) return ['', new Error('THEGRAPH_API_KEY is required. Set it in .env or run without --no-setup for interactive setup.')];
  const c = await loadChalk();
  console.log(`
${c.cyanBright('Subnet 77 — Weight Verification Setup')}
${c.gray('─'.repeat(44))}

Independent verification fetches Uniswap V3 LP positions from ${c.white('The Graph')}.
You need an API key to query the subgraph directly.

${c.yellow('Missing:')} ${c.white('THEGRAPH_API_KEY')} in your ${c.white('.env')}

${c.bold('Get a free API key:')}
  ${c.blue(GRAPH_KEYS_URL)}
  ${c.gray('Guide:')} ${GRAPH_DOCS_URL}

${c.gray('1. Sign in to Subgraph Studio')}
${c.gray('2. API Keys → Create API Key')}
${c.gray('3. Copy the token and paste it below')}
`);
  const key = (await prompt(`${c.green('?')} Paste your The Graph API key: `)).trim();
  if (!key) return ['', new Error('No API key provided. Set THEGRAPH_API_KEY in .env or re-run and paste your key.')];
  const saveAnswer = await prompt(`\n${c.green('?')} Save THEGRAPH_API_KEY to .env? ${c.gray('[Y/n]')} `);
  if (isYes(saveAnswer)) {
    await upsertEnvVar('THEGRAPH_API_KEY', key);
    console.log(c.green(`✓ Saved THEGRAPH_API_KEY to .env\n`));
  } else console.log(c.gray('Skipped .env update — using key for this run only.\n'));
  return [key, null];
};
