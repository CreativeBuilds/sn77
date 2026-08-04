import { ApiPromise, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import 'dotenv/config';

// Standard [value, err] tuple type
export type Result<T> = [T, Error | null];

async function getValidatorWeights(hotkey: string, netuid = 77): Promise<Result<number[]>> {
  try {
    const wsUrl = process.env.BITTENSOR_WS_URL || 'wss://entrypoint-finney.opentensor.ai:443';
    const provider = new WsProvider(wsUrl);
    const api = await ApiPromise.create({ provider });
    await api.isReady;

    let uid: number | null = null;
    // Resolve UID for hotkey (storage name changed in newer runtimes)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore – access dynamic storage items safely
    if (api.query.subtensorModule.keyToUid) {
      // Legacy mapping
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const uidCodec = await api.query.subtensorModule.keyToUid(netuid, hotkey);
      const uidResult = (uidCodec as any).toString();
      if (uidResult && uidResult !== '0x') uid = Number(uidResult);
    } else if ((api.query.subtensorModule as any).uids) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const uidCodec = await (api.query.subtensorModule as any).uids(netuid, hotkey);
      const uidResult = (uidCodec as any).toString();
      if (uidResult && uidResult !== '0x') uid = Number(uidResult);
    }

    if (uid === null) return [[], new Error('hotkey not registered on subnet')];

    // Fetch weight vector for the validator uid
    let floats: number[] = [];
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const weightsCodec = await api.query.subtensorModule.weights(netuid, uid);
      const raw = (weightsCodec as any).toJSON();
      if (Array.isArray(raw)) {
        const pairs: [number, number][] = raw as [number, number][];
        floats = [];
        for (const [target, w] of pairs) floats[target] = w / 65535;
      }
    } catch (wErr) {
      // Ignore weight fetch errors; return empty
      console.warn('failed to fetch weights:', (wErr as Error).message);
    }

    return [floats, null];
  } catch (err) {
    return [[], err instanceof Error ? err : new Error(String(err))];
  }
}

async function main(): Promise<Result<void>> {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: bunx tsx scripts/weights.ts <hotkey> [--netuid 77]')
    .option('netuid', { alias: 'n', type: 'number', default: 77, describe: 'Subnet netuid' })
    .help(false)
    .version(false)
    .parseSync();

  const hotkey = argv._[0] as string | undefined;
  if (!hotkey) return [undefined, new Error('hotkey argument missing')];
  const netuid = argv.netuid as number;

  const [weights, err] = await getValidatorWeights(hotkey, netuid);
  if (err) return [undefined, err];

  const nonZero = weights
    .map((w, idx) => ({ uid: idx, weight: w }))
    .filter(({ weight }) => weight > 0);

  if (!nonZero.length) {
    console.log('all weights are zero');
    return [undefined, null];
  }

  const sum = nonZero.reduce((s, { weight }) => s + weight, 0);
  nonZero.sort((a, b) => b.weight - a.weight);
  console.log(`uid \t weight`);
  nonZero.forEach(({ uid, weight }) => console.log(`${uid}\t${weight.toFixed(6)}`));
  console.log(`sum: ${sum.toFixed(6)}`);
  return [undefined, null];
}

void main().then(([_, err]) => { if (err) { console.error(err.message); process.exit(1); } });
