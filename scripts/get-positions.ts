import axios from 'axios';
import { ApiPromise, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs/promises';
import path from 'path';

// #region Interfaces
interface Token {
    id: string;
    name: string;
    symbol: string;
    decimals: string;
}

interface Pool {
    id: string;
    feeTier: string;
    tick: string;
    token0Price: string;
    token1Price: string;
}

interface Tick {
    id: string;
    tickIdx: string;
}

interface Position {
    id: string;
    owner: string;
    pool: Pool;
    token0: Token;
    token1: Token;
    tickLower: Tick;
    tickUpper: Tick;
    depositedToken0: string;
    depositedToken1: string;
    liquidity: string;
    emission: number;
}

interface PositionsResponse {
    success: boolean;
    positions: Record<string, Position[]>;
    cached: boolean;
}
// #endregion

const BITTENSOR_ENDPOINT = 'wss://entrypoint-finney.opentensor.ai:443';
const API_URL = process.env.PRODUCTION_URL ||'http://77.creativebuilds.io/positions';

const getPositions = async (): Promise<[PositionsResponse | null, Error | null]> => {
    try {
        const response = await axios.get<PositionsResponse>(API_URL);
        if (response.status !== 200) {
            return [null, new Error(`Failed to fetch positions. Status: ${response.status}`)];
        }
        return [response.data, null];
    } catch (error) {
        return [null, error as Error];
    }
};

const getPolkadotApi = async (): Promise<[ApiPromise | null, Error | null]> => {
    try {
        const provider = new WsProvider(BITTENSOR_ENDPOINT);
        const api = await ApiPromise.create({ provider });
        return [api, null];
    } catch (error) {
        return [null, error as Error];
    }
}

const getHotkeyForUid = async (api: ApiPromise, netuid: number, uid: number): Promise<[string | null, Error | null]> => {
    try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const hotkey = await api.query.subtensorModule.keys(netuid, uid);
        const hotkeyStr = (hotkey as any).toString();
        if (!hotkeyStr) {
            return [null, new Error(`Could not find hotkey for UID ${uid} in NetUID ${netuid}`)]
        }
        return [hotkeyStr, null];
    } catch (error) {
        return [null, error as Error];
    }
};

const getAllMiners = async (api: ApiPromise, netuid: number): Promise<[Record<string, number> | null, Error | null]> => {
    try {
        // Get total number of UIDs in the subnet
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const totalBn = await api.query.subtensorModule.subnetworkN(netuid);
        const total = (totalBn as any).toNumber?.() ?? Number(totalBn);
        
        if (total === 0) {
            return [{}, null];
        }
        
        const miners: Record<string, number> = {};
        const BATCH = 8;
        
        for (let start = 0; start < total; start += BATCH) {
            const batchEnd = Math.min(start + BATCH, total);
            
            const tasks: Promise<void>[] = [];
            for (let uid = start; uid < batchEnd; uid++) {
                tasks.push(
                    (async () => {
                        try {
                            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                            // @ts-ignore
                            const hotkey = await api.query.subtensorModule.keys(netuid, uid);
                            const hotkeyStr = (hotkey as any).toString();
                            if (hotkeyStr) {
                                miners[hotkeyStr] = uid;
                            }
                        } catch (error) {
                            console.warn(`Failed to fetch hotkey for UID ${uid}:`, error);
                        }
                    })(),
                );
            }
            await Promise.all(tasks);
        }

        return [miners, null];
    } catch (error) {
        return [null, error as Error];
    }
};


const prettyPrintPositions = (chalk: any, hotkey: string, positions: Position[], uid?: number) => {
    const header = uid !== undefined ? `Miner UID: ${chalk.cyan(uid)} | Hotkey: ${chalk.yellow(hotkey)}` : `Hotkey: ${chalk.yellow(hotkey)}`;
    console.log(chalk.bold.green('======================================================================'));
    console.log(chalk.bold.green(header));
    console.log(chalk.bold.green('======================================================================'));

    if (positions.length === 0) {
        console.log(chalk.gray('No liquidity positions found.'));
        console.log('');
        return;
    }

    positions.forEach((pos, index) => {
        console.log(chalk.bold.blue(`\n--- Position #${index + 1} (ID: ${pos.id}) ---`));
        console.log(`  ${chalk.white('Owner:')} ${chalk.magenta(pos.owner)}`);
        console.log(`  ${chalk.white('Pool:')} ${chalk.cyan(pos.pool.id)} (Fee: ${Number(pos.pool.feeTier) / 10000}%)`);
        console.log(`  ${chalk.white('Liquidity:')} ${chalk.yellow(pos.liquidity)}`);
        console.log(`  ${chalk.white('Emission:')} ${chalk.red(pos.emission.toFixed(18))}`);

        console.log(chalk.bold.white('\n  Tokens:'));
        console.log(`    - ${chalk.yellow(pos.token0.symbol)}: ${chalk.green(pos.depositedToken0)} (Dec: ${pos.token0.decimals})`);
        console.log(`    - ${chalk.yellow(pos.token1.symbol)}: ${chalk.green(pos.depositedToken1)} (Dec: ${pos.token1.decimals})`);

        console.log(chalk.bold.white('\n  Tick Range:'));
        console.log(`    Lower: ${chalk.cyan(pos.tickLower.tickIdx)} | Upper: ${chalk.cyan(pos.tickUpper.tickIdx)}`);
    });
    console.log('');
};


const main = async () => {
    const { default: chalk } = await import('chalk');
    const { default: inquirer } = await import('inquirer');

    const argv = await yargs(hideBin(process.argv))
        .option('uid', {
            type: 'number',
            description: 'The UID of the miner to fetch positions for.',
        })
        .option('netuid', {
            type: 'number',
            description: 'The NetUID of the subnet.',
            default: 77
        })
        .help()
        .argv;

    console.log(chalk.yellow('Fetching liquidity positions...'));
    const [positionsData, pError] = await getPositions();
    if (pError || !positionsData) {
        console.error(chalk.red('Error fetching positions:'), pError);
        process.exit(1);
    }
    const { positions } = positionsData;
    let positionsToSave: Record<string, any> = {};


    console.log(chalk.yellow('Connecting to Bittensor network...'));
    const [api, apiError] = await getPolkadotApi();
    if (apiError || !api) {
        console.error(chalk.red('Error connecting to Bittensor:'), apiError);
        process.exit(1);
    }

    if (argv.uid !== undefined) {
        const [hotkey, hError] = await getHotkeyForUid(api, argv.netuid, argv.uid);
        if (hError || !hotkey) {
            console.error(chalk.red(`Error fetching hotkey for UID ${argv.uid}:`), hError);
        } else {
            if (positions[hotkey]) {
                prettyPrintPositions(chalk, hotkey, positions[hotkey], argv.uid);
                positionsToSave = { [hotkey]: positions[hotkey] };
            } else {
                console.log(chalk.yellow(`No positions found for UID ${argv.uid} (hotkey: ${hotkey})`));
            }
        }
    } else {
        console.log(chalk.yellow('Fetching all miners...'));
        const [miners, mError] = await getAllMiners(api, argv.netuid);
        if (mError || !miners) {
            console.error(chalk.red('Error fetching miners:'), mError);
        } else {
            const hotkeysWithPositions = Object.keys(positions).filter(h => positions[h].length > 0);
            if (hotkeysWithPositions.length === 0) {
                 console.log(chalk.yellow(`No miners with active positions found.`));
            }

            for (const hotkey of hotkeysWithPositions) {
                const uid = miners[hotkey];
                prettyPrintPositions(chalk, hotkey, positions[hotkey], uid);
            }
            positionsToSave = positions;
        }
    }
    
    await api.disconnect();
    
    if (Object.keys(positionsToSave).length > 0) {
        const { save } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'save',
                message: 'Do you want to save this information to a file?',
                default: false,
            },
        ]);

        if (save) {
            const defaultFileName = `positions_${new Date().toISOString().split('T')[0]}.json`;
            const { filename } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'filename',
                    message: 'Enter filename:',
                    default: defaultFileName,
                },
            ]);

            try {
                const filePath = path.resolve(process.cwd(), filename);
                await fs.writeFile(filePath, JSON.stringify(positionsToSave, null, 2));
                console.log(chalk.green(`\nSuccessfully saved to ${filePath}`));
            } catch (error) {
                console.error(chalk.red('\nError saving file:'), error);
            }
        }
    }
};

main().catch(error => {
    console.error('An unexpected error occurred:', error);
    process.exit(1);
}); 