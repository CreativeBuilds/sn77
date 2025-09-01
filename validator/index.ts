/**
 * This is the main validator code for sn77
 * 
 * Determines the weight of each miner and sets weight every interval.
 */

import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { ISubmittableResult } from '@polkadot/types/types';
import { u8aToHex } from '@polkadot/util';

// ----------------------
//  Logging Configuration
// ----------------------
// Must be set up *before* other imports execute arbitrary logging.
const TEST_MODE = (process.env.TEST_MODE || 'false').toLowerCase() === 'true';
const LOG_CONSOLE = (process.env.LOG || 'false').toLowerCase() === 'true' || TEST_MODE;
const logDir = path.join(__dirname, '..', 'logs');
fs.mkdir(logDir, { recursive: true }).catch(() => {});
const LOG_FILE_PATH = path.join(logDir, `validator-${new Date().toISOString().slice(0, 10)}.log`);

// ----------------------
//  Version Management
// ----------------------
const packageJson = require(path.join(__dirname, '..', 'package.json'));
const CLIENT_VERSION = packageJson.version;
const PING_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const VERSION_CHECK_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours
const VERSION_WARNING_FILE = path.join(logDir, 'version-warning.json');
const AUTO_UPDATE_ENABLED = (process.env.AUTO_UPDATE_ENABLED || 'false').toLowerCase() === 'true';

// Preserve originals
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

const appendLog = (level: string, args: any[]): void => {
    const line = `[${new Date().toISOString()}] ${level}: ` + args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    
    // Append the new line
    fs.appendFile(LOG_FILE_PATH, line + '\n').then(async () => {
        // Check if we need to trim the log file
        try {
            const stats = await fs.stat(LOG_FILE_PATH);
            if (stats.size > 0) {
                const content = await fs.readFile(LOG_FILE_PATH, 'utf-8');
                const lines = content.split('\n');
                if (lines.length > 10000) {
                    const trimmedLines = lines.slice(-10000); // Keep last 10000 lines
                    await fs.writeFile(LOG_FILE_PATH, trimmedLines.join('\n'));
                }
            }
        } catch (trimErr) {
            // Silently ignore trim errors to avoid logging loops
        }
    }).catch(() => {});
};

console.log = (...args: any[]): void => {
    appendLog('LOG', args);
    if (LOG_CONSOLE) _origLog(...args);
};

console.warn = (...args: any[]): void => {
    appendLog('WARN', args);
    if (LOG_CONSOLE) _origWarn(...args);
};

console.error = (...args: any[]): void => {
    appendLog('ERROR', args);
    _origError(...args); // always show errors
};

// For messages that should *always* be shown to the user, regardless of LOG flag
function importantLog(...args: any[]): void {
    appendLog('IMPORTANT', args);
    _origLog(...args);
}

function userLog(...args: any[]): void {
    _origLog(`[${new Date().toISOString()}]`, ...args);
}

// Load environment variables from .env file
dotenv.config();

// Toggle test mode via env var; when true, weights are not pushed on-chain
// Default to false unless explicitly set to true
if (TEST_MODE) {
    console.log('Running in TEST_MODE: weights will be saved to JSON files instead of being pushed on-chain');
    console.log('Console logging is automatically enabled in TEST_MODE');
    // Ensure weights directory exists
    const weightsDir = path.join(logDir, 'weights');
    fs.mkdir(weightsDir, { recursive: true }).catch(err => {
        console.error('Failed to create weights directory:', err);
    });
}

interface WeightsResponse {
  success: boolean;
  weights: Record<string, number>;
  cached: boolean;
  error?: string;
}

// Type alias for the standard return pattern [value, error]
type Result<T> = [T, Error | null];

// Utility function for adding delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Version management functions
async function getCurrentBlockNumber(): Promise<number> {
    if (!btApi) return 0;
    try {
        const header = await btApi.rpc.chain.getHeader();
        return header.number.toNumber();
    } catch (err) {
        console.error('Failed to get current block number:', err);
        return 0;
    }
}

async function signMessage(message: string): Promise<string> {
    if (!signer) throw new Error('Signer not initialized');
    const encoded = new TextEncoder().encode(message);
    const signature = signer.sign(encoded);
    return u8aToHex(signature);
}

async function pingServer(): Promise<[PingResponse | null, Error | null]> {
    try {
        const blockNumber = await getCurrentBlockNumber();
        if (blockNumber === 0) {
            return [null, new Error('Failed to get current block number')];
        }

        const message = `${blockNumber}|${CLIENT_VERSION}`;
        const signature = await signMessage(message);
        const hotkeyAddress = signer?.address;
        
        if (!hotkeyAddress) {
            return [null, new Error('Hotkey address not available')];
        }

        const response = await fetch(`${process.env.PRODUCTION_URL || 'https://77.creativebuilds.io'}/ping`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                signature,
                message,
                address: hotkeyAddress
            })
        });

        if (!response.ok) {
            return [null, new Error(`Server responded with status ${response.status}: ${response.statusText}`)];
        }

        const data = await response.json() as PingResponse;
        return [data, null];
    } catch (err) {
        return [null, err instanceof Error ? err : new Error(String(err))];
    }
}

async function loadVersionWarning(): Promise<VersionWarning | null> {
    try {
        const data = await fs.readFile(VERSION_WARNING_FILE, 'utf-8');
        return JSON.parse(data) as VersionWarning;
    } catch {
        return null;
    }
}

async function saveVersionWarning(warning: VersionWarning): Promise<void> {
    try {
        await fs.writeFile(VERSION_WARNING_FILE, JSON.stringify(warning, null, 2));
    } catch (err) {
        console.error('Failed to save version warning:', err);
    }
}

async function checkVersionCompatibility(): Promise<[boolean, Error | null]> {
    const [pingResponse, pingErr] = await pingServer();
    if (pingErr) {
        console.error('Failed to ping server:', pingErr);
        return [false, pingErr];
    }

    if (!pingResponse) {
        return [false, new Error('No ping response received')];
    }

    // Check if this is a version incompatibility response (server returns success: false with versionCompatible: false)
    if (!pingResponse.success && pingResponse.versionCompatible === false) {
        // This is a version incompatibility - trigger auto-update
        const now = Date.now();
        const existingWarning = await loadVersionWarning();
        
        if (!existingWarning) {
            // First time seeing this version incompatibility
            const newWarning: VersionWarning = {
                firstWarningTime: now,
                lastWarningTime: now,
                serverVersion: pingResponse.serverVersion,
                clientVersion: pingResponse.clientVersion,
                warningCount: 1
            };
            await saveVersionWarning(newWarning);
            
            const errorMsg = `Version incompatibility detected! Server version: ${pingResponse.serverVersion}, Client version: ${pingResponse.clientVersion}`;
            console.error(errorMsg);
            
            if (AUTO_UPDATE_ENABLED) {
                console.log('Auto-update enabled. Attempting to update...');
                await attemptAutoUpdate();
            } else {
                console.error('Auto-update disabled. Please update manually or set AUTO_UPDATE_ENABLED=true');
            }
            
            return [false, new Error(errorMsg)];
        }

        // Update existing warning
        existingWarning.lastWarningTime = now;
        existingWarning.warningCount++;
        existingWarning.serverVersion = pingResponse.serverVersion;
        existingWarning.clientVersion = pingResponse.clientVersion;
        await saveVersionWarning(existingWarning);

        const timeSinceFirstWarning = now - existingWarning.firstWarningTime;
        
        if (timeSinceFirstWarning >= VERSION_CHECK_TIMEOUT_MS) {
            const errorMsg = `Version incompatibility timeout reached (12h). Shutting down validator. Server: ${pingResponse.serverVersion}, Client: ${pingResponse.clientVersion}`;
            console.error(errorMsg);
            return [false, new Error(errorMsg)];
        }

        const errorMsg = `Version incompatibility detected! Server: ${pingResponse.serverVersion}, Client: ${pingResponse.clientVersion}. Time remaining: ${Math.round((VERSION_CHECK_TIMEOUT_MS - timeSinceFirstWarning) / (60 * 60 * 1000))}h`;
        console.error(errorMsg);
        
        if (AUTO_UPDATE_ENABLED) {
            console.log('Auto-update enabled. Attempting to update...');
            await attemptAutoUpdate();
        }
        
        return [false, new Error(errorMsg)];
    }

    // Handle other failure cases (not version related)
    if (!pingResponse.success) {
        return [false, new Error(pingResponse.error || 'Ping failed')];
    }

    // Success case - versions are compatible
    if (pingResponse.versionCompatible) {
        // Clear any existing warning file if versions are now compatible
        try {
            await fs.unlink(VERSION_WARNING_FILE);
        } catch {
            // File doesn't exist, which is fine
        }
        return [true, null];
    }

    // This shouldn't happen (success: true but versionCompatible: false), but handle it
    const errorMsg = `Unexpected server response: success=true but versionCompatible=false`;
    console.error(errorMsg);
    return [false, new Error(errorMsg)];
}

async function attemptAutoUpdate(): Promise<void> {
    try {
        console.log('Attempting auto-update via git pull...');
        
        // Get current directory
        const currentDir = process.cwd();
        
        // Check if we're in a git repository
        try {
            execSync('git status', { cwd: currentDir, stdio: 'pipe' });
        } catch {
            console.error('Not in a git repository, cannot auto-update');
            return;
        }
        
        // Fetch latest changes
        execSync('git fetch origin', { cwd: currentDir, stdio: 'pipe' });
        
        // Get current branch
        const currentBranch = execSync('git branch --show-current', { cwd: currentDir, encoding: 'utf8' }).trim();
        
        // Pull latest changes
        execSync(`git pull origin ${currentBranch}`, { cwd: currentDir, stdio: 'pipe' });
        
        // Install dependencies
        console.log('Installing updated dependencies...');
        execSync('bun install', { cwd: currentDir, stdio: 'pipe' });
        
        console.log('Auto-update completed successfully. Restarting validator...');
        
        // Restart the process
        process.exit(0);
    } catch (err) {
        console.error('Auto-update failed:', err);
    }
}

// global bittensor vars & initializer (placed after RAO_PER_TAO const)
const NETUID = 77
let btApi: ApiPromise | null = null;
let signer: ReturnType<Keyring['addFromUri']> | null = null;

// Cache for weights data
interface CachedWeights {
  data: Record<string, number>;
  timestamp: number;
}

let cachedWeights: CachedWeights | null = null;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

interface RegistryMapResponse {
  success: boolean;
  miners: Array<{ hotkeyAddress: string, ethereumAddress: string | null }>;
  totalMiners: number;
  linkedMiners: number;
  error?: string;
}

interface PingResponse {
  success: boolean;
  message: string;
  serverVersion: string;
  clientVersion: string;
  versionCompatible: boolean;
  error?: string;
}

interface VersionWarning {
  firstWarningTime: number;
  lastWarningTime: number;
  serverVersion: string;
  clientVersion: string;
  warningCount: number;
}

async function initializeBittensor(): Promise<Error | null> {
    async function attemptReconnect(wsUrl: string): Promise<void> {
        let delayMs = 1000; // start with 1s
        while (true) {
            try {
                userLog(`Attempting Bittensor WS reconnection...`);
                const newProvider = new WsProvider(wsUrl);
                const newApi = await ApiPromise.create({ provider: newProvider });
                await newApi.isReady;

                btApi = newApi;
                userLog(`Reconnected to Bittensor WS`);
                // re-attach disconnect handler
                newProvider.on('disconnected', () => {
                    userLog('Bittensor WS disconnected');
                    void attemptReconnect(wsUrl);
                });
                break;
            } catch (reErr) {
                console.error('Reconnection attempt failed:', reErr);
                await delay(delayMs);
                delayMs = Math.min(delayMs * 2, 30000); // cap at 30s
            }
        }
    }

    try {
        if (btApi) return null; // already initialized
        const wsUrl = 'wss://entrypoint-finney.opentensor.ai:443';
        const provider = new WsProvider(wsUrl);
        provider.on('disconnected', () => {
            userLog('Bittensor WS disconnected');
            void attemptReconnect(wsUrl);
        });

        btApi = await ApiPromise.create({ provider });
        await btApi.isReady;

        const hotkeyUri = process.env.VALIDATOR_HOTKEY_URI;
        if (!hotkeyUri) return new Error('VALIDATOR_HOTKEY_URI env var not set');
        
        const keyring = new Keyring({ type: 'sr25519' });
        
        try {
            signer = keyring.addFromUri(hotkeyUri);
        } catch (keyErr) {
            console.error(`Failed to create signer from URI: ${keyErr}`);
            return new Error(`Invalid VALIDATOR_HOTKEY_URI format: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`);
        }

        // Verify neuron registration if storage available
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        if (btApi.query.subtensorModule?.keyToUid) {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const uidCodec = await btApi.query.subtensorModule.keyToUid(NETUID, signer.address);
            const uidNum = (uidCodec as any)?.toNumber ? (uidCodec as any).toNumber() : 0;
            console.log(`Hotkey registration check: UID ${uidNum} on netuid ${NETUID}`);
            if (uidNum === 0) return new Error('Hotkey not registered on subnet');
        }
        return null;
    } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
    }
}

async function main(): Promise<void> {
    const bittensorErr = await initializeBittensor();
    if (bittensorErr) {
        console.error('Failed to initialize Bittensor:', bittensorErr);
        process.exit(1);
        return;
    }

    // Check for existing version warning on startup
    const existingWarning = await loadVersionWarning();
    if (existingWarning) {
        const timeSinceFirstWarning = Date.now() - existingWarning.firstWarningTime;
        if (timeSinceFirstWarning >= VERSION_CHECK_TIMEOUT_MS) {
            console.error('Version incompatibility timeout reached on startup. Shutting down validator.');
            process.exit(1);
            return;
        }
        
        // Check version compatibility immediately
        const [isCompatible, versionErr] = await checkVersionCompatibility();
        if (versionErr) {
            console.error('Version check failed on startup:', versionErr);
            // If we have an existing warning and AUTO_UPDATE_ENABLED, try to update
            // This handles cases where we already know there's a version issue
            if (AUTO_UPDATE_ENABLED) {
                console.log('Existing version warning detected and auto-update enabled. Attempting to update...');
                await attemptAutoUpdate();
            }
        }
    }

    // ---------------------------
    //  PERIODIC LOOP W/ EMA LOGIC
    // ---------------------------
    const LOOP_DELAY_MS = Number(process.env.LOOP_DELAY_MS || 300000); // default 5 minutes
    const SET_INTERVAL_MS = Number(process.env.SET_INTERVAL_MS || 101 * 12 * 1000); // 101 Blocks
    const EMA_ALPHA = Number(process.env.EMA_ALPHA || 0.2);
    const MAX_CONSECUTIVE_ERRORS = 5;

    let emaWeights: Record<string, number> = {};
    let lastSet = 0;
    let lastVersionCheck = 0;
    let iteration = 0;
    let consecutiveErrors = 0;

    const updateEma = (prev: Record<string, number>, curr: Record<string, number>): Record<string, number> => {
        const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
        const next: Record<string, number> = {};
        for (const k of keys) {
            const prevVal = prev[k] ?? 0;
            const currVal = curr[k] ?? 0;
            
            // Safety check for NaN or invalid values
            const safePrev = isFinite(prevVal) ? prevVal : 0;
            const safeCurr = isFinite(currVal) ? currVal : 0;
            
            next[k] = EMA_ALPHA * safeCurr + (1 - EMA_ALPHA) * safePrev;
            
            // Additional safety check on the result
            if (!isFinite(next[k])) {
                console.warn(`EMA calculation resulted in invalid value for key ${k}, setting to 0`);
                next[k] = 0;
            }
        }
        return next;
    };

    // Helper to ensure each loop starts after exactly LOOP_DELAY_MS
    const waitRemaining = async (startTime: number): Promise<Error | null> => {
        let remaining = LOOP_DELAY_MS - (Date.now() - startTime);
        if (remaining <= 0) return null;

        if (!LOG_CONSOLE) {
            // Display dynamic countdown in seconds on the same console line
            while (remaining > 0) {
                const secs = Math.ceil(remaining / 1000);
                process.stdout.write(`\rNext iteration in ${secs}s   `);
                const step = Math.min(1000, remaining);
                await delay(step);
                remaining -= step;
            }
            process.stdout.write('\r\n'); // move to next line after countdown finishes
        } else {
            await delay(remaining);
        }
        return null;
    };

    while (true) {
        try {
            const startTime = Date.now();
            userLog(`\nIteration ${++iteration} starting...`);

            // Fetch weights from the central server
            const [hotkeyWeights, weightsErr] = await fetchWeightsFromServer();
            if (weightsErr) {
                console.error('Error fetching weights:', weightsErr);
                consecutiveErrors++;
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    console.error(`Too many consecutive errors (${consecutiveErrors}), exiting...`);
                    process.exit(1);
                    return;
                }
                await waitRemaining(startTime);
                continue;
            }

            if (!hotkeyWeights) {
                console.error('No weights data received from server');
                consecutiveErrors++;
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    console.error(`Too many consecutive errors (${consecutiveErrors}), exiting...`);
                    process.exit(1);
                    return;
                }
                await waitRemaining(startTime);
                continue;
            }

            // Reset error counter on successful iteration
            consecutiveErrors = 0;

            // Fetch registry map to map hotkeys to UIDs
            const [registryMap, registryErr] = await fetchRegistryMap();
            if (registryErr) {
                console.error('Error fetching registry map:', registryErr);
                await waitRemaining(startTime);
                continue;
            }

            if (!registryMap || !registryMap.miners) {
                console.error('No registry map data received');
                await waitRemaining(startTime);
                continue;
            }
            
            const hotkeyToUid: Record<string, number> = {};
            registryMap.miners.forEach((miner, i) => {
                hotkeyToUid[miner.hotkeyAddress] = i;
            });

            // Convert hotkey-based weights to UID-based weights
            const uidWeights: Record<string, number> = {};
            for (const [hotkey, weight] of Object.entries(hotkeyWeights)) {
                const uid = hotkeyToUid[hotkey];
                if (uid !== undefined) {
                    uidWeights[uid.toString()] = weight;
                } else {
                    console.warn(`No UID found for hotkey ${hotkey} in registry map, skipping.`);
                }
            }

            userLog(`Received weights for ${Object.keys(uidWeights).length} UIDs from the server.`);
            
            // Log weights data if console logging is enabled
            if (LOG_CONSOLE) {
                console.log(`Mapped weights (uid:address:weight):`);
                Object.entries(uidWeights).forEach(([uid, weight]) => {
                    const address = Object.keys(hotkeyWeights).find(key => hotkeyToUid[key] === Number(uid));
                    console.log(`  ${uid}:${address}: ${weight.toFixed(6)}`);
                });
            }
            
            // Update EMA weights (by uid)
            emaWeights = updateEma(emaWeights, uidWeights);

            // Periodic version compatibility check
            const timeSinceLastVersionCheck = Date.now() - lastVersionCheck;
            if (timeSinceLastVersionCheck >= PING_INTERVAL_MS) {
                userLog('Performing periodic version compatibility check...');
                const [isCompatible, versionErr] = await checkVersionCompatibility();
                if (versionErr) {
                    console.error('Version compatibility check failed:', versionErr);
                    // Don't exit immediately, let the timeout mechanism handle it
                } else {
                    userLog('Version compatibility check passed');
                }
                lastVersionCheck = Date.now();
            }

            // Check if it's time to set weights
            const timeSinceLastSet = Date.now() - lastSet;
            if (timeSinceLastSet >= SET_INTERVAL_MS) {
                if (!TEST_MODE) {
                    // Normalize weights before setting
                    const [normalizedWeights, normErr] = await normalizeFinalMinerWeights(emaWeights);
                    if (normErr) {
                        console.error('Error normalizing weights:', normErr);
                    } else {
                        const [, setErr] = await setWeightsOnNetwork(normalizedWeights);
                        if (setErr) {
                            console.error('Error setting weights:', setErr);
                            consecutiveErrors++;
                            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                                console.error(`Too many consecutive errors (${consecutiveErrors}), exiting...`);
                                process.exit(1);
                                return;
                            }
                        } else {
                            userLog('Successfully set weights on network');
                            lastSet = Date.now();
                        }
                    }
                } else {
                    userLog('TEST_MODE: Skipping weight setting');
                    lastSet = Date.now();
                }
            }

            await waitRemaining(startTime);
        } catch (err) {
            console.error('Error in main loop:', err);
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.error(`Too many consecutive errors (${consecutiveErrors}), exiting...`);
                process.exit(1);
                return;
            }
            await delay(LOOP_DELAY_MS);
        }
    }
}

async function normalizeFinalMinerWeights(finalMinerWeights: Record<string, number>): Promise<Result<Record<string, number>>> {
    const normalizedFinalMinerWeights: Record<string, number> = {};
    const totalWeight = Object.values(finalMinerWeights).reduce((sum, weight) => sum + weight, 0);
    
    // Handle case where totalWeight is 0, NaN, or invalid
    if (!totalWeight || totalWeight <= 0 || !isFinite(totalWeight)) {
        const minerIds = Object.keys(finalMinerWeights);
        const uniformWeight = minerIds.length > 0 ? 1 / minerIds.length : 0;
        
        console.warn(`Invalid or zero total weight (${totalWeight}), using uniform distribution: ${uniformWeight.toFixed(6)} per miner`);
        for (const minerId of minerIds) {
            normalizedFinalMinerWeights[minerId] = uniformWeight;
        }
        return [normalizedFinalMinerWeights, null];
    }
    
    for (const [minerId, weight] of Object.entries(finalMinerWeights)) {
        // Additional safety check for individual weights
        if (!isFinite(weight) || weight < 0) {
            console.warn(`Invalid weight ${weight} for miner ${minerId}, setting to 0`);
            normalizedFinalMinerWeights[minerId] = 0;
        } else {
            normalizedFinalMinerWeights[minerId] = weight / totalWeight;
        }
    }
    return [normalizedFinalMinerWeights, null];
}

async function setWeightsOnNetwork(normalizedFinalMinerWeights: Record<string, number>): Promise<Result<Record<string, number>>> {
    try {
        // Always save weights to a timestamped JSON file for inspection
        try {
            const weightsDir = path.join(logDir, 'weights');
            await fs.mkdir(weightsDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const filePath = path.join(weightsDir, `${ts}.json`);
            await fs.writeFile(filePath, JSON.stringify({
                weights: normalizedFinalMinerWeights,
                timestamp: new Date().toISOString(),
                testMode: TEST_MODE
            }, null, 2));
            userLog(`Weights saved to ${filePath}`);
        } catch (fileErr) {
            console.error('Failed to write weights file:', fileErr);
        }

        if (TEST_MODE) {
            console.log('[TEST_MODE] Skipping setWeightsOnNetwork call. Weights that would be set:', JSON.stringify(normalizedFinalMinerWeights, null, 2));
            return [normalizedFinalMinerWeights, null];
        }

        if (!btApi || !signer) {
            const error = new Error('Bittensor API not initialized');
            console.error(error);
            return [{}, error];
        }

        // Verify API connection is still active
        try {
            await btApi.rpc.chain.getHeader();
        } catch (apiErr) {
            const error = new Error(`Bittensor API connection lost: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`);
            console.error(error);
            return [{}, error];
        }

        let entries = Object.entries(normalizedFinalMinerWeights);

        if (entries.length === 0) {
            console.warn('No miner weight data found – falling back to uniform weights across all registered UIDs.');
            const [uidsFallback, uidErr] = await fetchAllUids();
            if (uidErr) {
                console.error('Failed to fetch UIDs for fallback:', uidErr);
                return [{}, uidErr];
            }
            if (uidsFallback.length === 0) {
                const error = new Error('Unable to determine UIDs for uniform weight distribution');
                console.error(error);
                return [{}, error];
            }

            const uniform = 1 / uidsFallback.length;
            normalizedFinalMinerWeights = Object.fromEntries(uidsFallback.map(uid => [uid.toString(), uniform]));
            entries = Object.entries(normalizedFinalMinerWeights);
            console.log(`Applied uniform weight ${uniform.toFixed(6)} to ${uidsFallback.length} UIDs.`);
        }

        const uids = entries.map(([uid]) => Number(uid));
        const floatWeights = entries.map(([_, w]) => w);

        // Scale to u16 (0..65535) and ensure sum == 65535
        let scaled = floatWeights.map(w => Math.round(w * 65535));
        const totalScaled = scaled.reduce((a, b) => a + b, 0);
        if (totalScaled === 0) {
            const error = new Error('All scaled weights are zero');
            console.error(error);
            return [{}, error];
        }
        if (totalScaled !== 65535) {
            scaled = scaled.map(w => Math.round((w * 65535) / totalScaled));
        }

        const header = await btApi.rpc.chain.getHeader();
        const versionKey = header.number.toNumber();
        console.log('Setting weights on network...');
        console.log('Uids:', uids);
        console.log('Scaled:', scaled);
        console.log('Version key:', versionKey);

        // Submit extrinsic with timeout
        const txPromise = new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Transaction timeout after 5 minutes'));
            }, 300000); // 5 minute timeout

            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore – dynamic lookup of pallet in generated types
            const tx = btApi.tx.subtensorModule.setWeights(NETUID, uids, scaled, versionKey);

            tx.signAndSend(signer!, { nonce: -1 }, (result: ISubmittableResult) => {
                if (result.status.isFinalized || result.status.isInBlock) {
                    clearTimeout(timeoutId);
                    if (result.dispatchError) {
                        let errMsg = result.dispatchError.toString();
                        if (result.dispatchError.isModule) {
                            const decoded = btApi!.registry.findMetaError(result.dispatchError.asModule);
                            errMsg = `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`;
                        }
                        reject(new Error(errMsg));
                    } else {
                        resolve();
                    }
                } else if (result.isError) {
                    clearTimeout(timeoutId);
                    reject(new Error('Transaction error'));
                }
            }).catch(err => {
                clearTimeout(timeoutId);
                reject(err);
            });
        });

        await txPromise;
        return [normalizedFinalMinerWeights, null];
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Error in setWeightsOnNetwork:', error);
        return [{}, error];
    }
}

async function fetchAllUids(): Promise<Result<number[]>> {
    // Returns [uids, error]. Falls back to empty list on failure.
    try {
        if (!btApi) return [[], new Error('Bittensor API not initialized')];
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore – dynamic storage item lookup
        const totalCodec = await btApi.query.subtensorModule?.subnetworkN(NETUID);
        const total = (totalCodec as any)?.toNumber ? (totalCodec as any).toNumber() : 0;
        if (!total || total <= 0) return [[], new Error(`Invalid subnet size returned: ${total}`)];
        const uids = Array.from({ length: total }, (_, i) => i);
        return [uids, null];
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return [[], error];
    }
}

async function fetchWeightsFromServer(): Promise<[Record<string, number> | null, Error | null]> {
    const now = Date.now();

    // Return cached data if it exists and is not expired
    if (cachedWeights && (now - cachedWeights.timestamp) < CACHE_DURATION_MS) {
        userLog('Using cached weights data');
        return [cachedWeights.data, null];
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            userLog(`Fetching fresh weights from server (attempt ${attempt}/${maxRetries})`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

            const response = await fetch(`${process.env.PRODUCTION_URL || 'https://77.creativebuilds.io'}/weights`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Server responded with status ${response.status}: ${response.statusText}`);
            }

            const data = await response.json() as WeightsResponse;
            
            if (!data.success) {
                throw new Error(data.error || 'Failed to fetch weights');
            }

            // Update cache
            cachedWeights = {
                data: data.weights,
                timestamp: now
            };
            
            return [data.weights, null];
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (err instanceof Error && err.name === 'AbortError') {
                console.error('Request timed out');
            } else {
                console.error(`Attempt ${attempt} failed:`, lastError);
            }
            
            if (attempt < maxRetries) {
                const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                await delay(delayMs);
            }
        }
    }

    // If we have cached data but it's expired, use it as fallback
    if (cachedWeights) {
        console.warn('Using expired cached data due to fetch failures');
        return [cachedWeights.data, null];
    }

    return [null, lastError];
}

async function fetchRegistryMap(): Promise<[RegistryMapResponse | null, Error | null]> {
  try {
    const response = await fetch(`${process.env.PRODUCTION_URL || 'https://77.creativebuilds.io'}/allMiners`);
    const data = await response.json() as RegistryMapResponse;
    
    if (!data.success) return [null, new Error(data.error || 'Failed to fetch miners')];
    return [data, null];
  } catch (err) {
    return [null, err instanceof Error ? err : new Error(String(err))];
  }
}

main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
});