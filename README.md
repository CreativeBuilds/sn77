# Subnet77 Liquidity Auction & Voting

This project manages a liquidity mining system for the Bittensor ecosystem, where token holders vote on liquidity pools and validators process these votes to set miner weights on subnet 77.

## Architecture Overview

The system operates through a server (`https://77.creativebuilds.io`) that handles:
- **Vote Collection**: Token holders submit weighted votes for liquidity pools
- **Weight Calculation**: The server processes votes and calculates final miner weights
- **Validator Integration**: Validators fetch weights from the server and set them on-chain

## Core Components

### Server
- **Vote Management**: Collects and stores user votes with Ed25519 signature verification
- **Weight Calculation**: Processes votes and calculates final miner weights based on token holdings and liquidity positions
- **API Endpoints**: Provides RESTful API for all system operations

### Validator (`validator/index.ts`)
- **Weight Fetching**: Retrieves calculated weights from the server
- **On-chain Updates**: Sets miner weights on the Bittensor network
- **Version Management**: Includes automatic version checking and update capabilities

### Scripts
- **Voting**: Submit weighted votes for liquidity pools
- **Registration**: Link Bittensor hotkeys to Ethereum addresses
- **Pool Management**: View current pool information and voting status
- **Weight Verification**: Independently recompute and audit central API miner weights

## Quick Start

1. **Install dependencies** (Bun is the primary runtime)

```bash
bun install
```

2. **Set up environment variables**

```bash
cp .env.example .env
# Fill in the required variables (see Environment section below)
```

3. **Query current pool weights**

```bash
bun run pools
```

## User Roles & Actions

### 🏦 Token Holders (Voters)

Token holders can vote on which liquidity pools should receive weight in the system.

**What you can do:**
- **Vote on pools**: Submit weighted votes for active liquidity pools
- **Check pool status**: View current pool weights and rankings
- **Monitor your voting power**: Track your influence based on token balance

**Key command:**
```bash
# Submit votes for pools (weights must sum to 10000)
just vote

# Retract all votes (send empty allocation)
just vote --retract
```

**Setup required:**
- `HOLDER_COLDKEY` in `.env` (your Bittensor coldkey for signing votes)

### ⚡ Validators

Validators read weights from the server and periodically push them to subnet 77.

**What you can do:**
- **Run the validator**: Fetch weights from the server and set them on subnet 77
- **Independently verify weights**: Recompute miner weights locally and compare to the central API
- **Monitor system health**: Track voting patterns and pool performance

**Key commands:**
```bash
# Start the validator (processes votes and submits weights)
just validate

# Independently verify central API weights (see Weight Verification below)
just verify-weights

# Run in test mode (compute weights but skip submission)
TEST_MODE=true just validate

# Enable verbose logging
LOG=true just validate
```

**Setup required:**
- `VALIDATOR_HOTKEY_URI` in `.env` (your validator hotkey)
- `THEGRAPH_API_KEY` in `.env` (required for `just verify-weights`; optional for running the validator itself)

### ⛏️ Miners

Miners provide liquidity to pools and can register their addresses to participate in the system.

**What you can do:**
- **Register your address**: Link your Bittensor public key to an EVM address
- **Provide liquidity**: Add liquidity to pools to earn rewards
- **Monitor earnings**: Track your pool performance and rewards

**Key commands:**
```bash
# Register your Bittensor public key with an EVM address
just register

# Check your registration status
bunx tsx scripts/check-key.ts

# View pool analytics and your position
bun run pools
```

**Setup required:**
- `MINER_HOTKEY` in `.env` (your Bittensor hotkey)
- `ETH_KEY` in `.env` (your Ethereum private key)
- Bittensor wallet with stake on subnet 77

## Scripts Reference

| Script | Purpose | Usage |
|--------|---------|-----------------|
| `create-key.ts` | Generate or import an **EVM keypair** and derive the corresponding **SS58** address. Stores everything in `.keys/` and can update `.env`. | `bunx tsx scripts/create-key.ts` |
| `register.ts` | Link a **Bittensor hotkey** → **EVM address** via the server. Requires `MINER_HOTKEY` and `ETH_KEY` environment variables. | `just register` |
| `vote.ts` | Interactive pool-weight voting. Searches and selects pools, then submits weighted votes that sum to 10000. Supports retracting votes with `--retract` flag. | `just vote` |
| `pools.ts` | Display current pool information from the API including pool details, voter information, and alpha token balances. | `just pools` |
| `verify-weights.ts` | Independently recompute miner weights from API inputs + The Graph, then compare to `/weights`. | `just verify-weights` |
| `weights.ts` | Read a validator's weight vector from chain for subnet 77. | `bunx tsx scripts/weights.ts <hotkey>` |

> Run scripts with `LOG=true` to enable verbose logging where available.

## Weight Verification

Validators (or anyone auditing the subnet) can independently confirm that `https://77.creativebuilds.io/weights` matches the published calculation — without trusting the server's LP or scoring logic.

### Quick verify

```bash
cp .env.example .env
just verify-weights
```

If `THEGRAPH_API_KEY` is not set, the script launches an interactive setup: it explains where to get a key ([Subgraph Studio](https://thegraph.com/studio/apikeys/)), prompts you to paste it, optionally saves it to `.env` `[Y/n]`, then runs verification.

On success you'll see a comparison table of local vs server weights. Exit code `0` on completion, `1` on fetch/calculation errors.

### What the script does

1. **From the central API** (inputs only): `/allVotes`, `/allHolders`, `/allMiners`, `/weights`
2. **From The Graph** (your API key): Uniswap V3 LP positions for linked miner ETH wallets
3. **Locally recomputes** final miner weights using `utils/weightCalculation.ts`
4. **Compares** local vs API weights in a full table (`hotkey | local | server | difference`)

Server weights are recalculated every ~5 minutes; drift may accumulate between refreshes and live tick movement.

### Options

```bash
# Skip interactive setup (CI / fail fast if key missing)
bun run scripts/verify-weights.ts --no-setup

# Debug: use API /positions instead of The Graph (not fully independent)
bun run scripts/verify-weights.ts --use-api-positions
```

Environment override: `PRODUCTION_URL`.

### Weight calculation formula

Implemented in `utils/weightCalculation.ts` (mirrors the production server).

**1. Pool emissions** — alpha-weighted votes across pools:

- Only voters with alpha balance > 0 count
- `weightMultiplier = voter_alpha / total_alpha`
- `poolEmission = Σ(pool_vote_weight × weightMultiplier) / 10000`

**2. Position score** — liquidity depth and proximity to current price:

- Position must be **in range**: `tickLower < currentTick < tickUpper` (strict)
- Gaussian score from distance to lower bound, midpoint (4× weight), and upper bound
- Std dev depends on fee tier: `100→10`, `500→50`, `3000→200`, `10000→500`
- `rawScore = gaussianMultiplier × (liquidity / 1e9)`

**3. Normalize within each pool** — each position gets its share of that pool's liquidity:

- `normalizedScore = position.rawScore / Σ(raw scores in same pool)`

**4. Final miner weight**:

- `minerWeight = Σ(normalizedScore × poolEmission)` per position
- Zero out weights below `1e-9`, then normalize all miners to sum to 1

Per-position `emission` exposed by `/positions` is `poolEmission × normalizedScore`. USD values from CoinGecko are display-only and do not affect weights.

## Justfile Commands

The project uses `just` as a command runner for common tasks:

| Command | Description |
|---------|-------------|
| `just register` | Register a Bittensor public key with an EVM address |
| `just vote` | Submit votes for liquidity pools |
| `just validate` | Start the validator to process votes and submit weights |
| `just verify-weights` | Recompute miner weights locally and compare to the central API |

## Environment Variables

Create a `.env` file in the project root. The most important keys are:

```dotenv
# VALIDATOR ONLY: this can be a private key, URI, or mnemonic
# Used to set weights on chain
VALIDATOR_HOTKEY_URI=

# Required for just verify-weights (independent LP fetch from The Graph)
THEGRAPH_API_KEY=

# Optional: central API base URL (default https://77.creativebuilds.io)
PRODUCTION_URL=

# VALIDATOR ONLY: set to 'true' to run in test mode (weights saved to files, not submitted to network)
TEST_MODE=false

# VOTER ONLY: hex string starting with 0x
# Used to sign votes in vote.ts script  
HOLDER_COLDKEY=

# MINER ONLY: hex string starting with 0x
# Used for hotkey in register.ts script
MINER_HOTKEY=

# MINER ONLY: ethereum private key hex string
# Used for ethereum wallet in register.ts script
ETH_KEY=

# VALIDATOR ONLY: OPT-IN: will automatically git pull when a new minor version is live
AUTO_UPDATE_ENABLED=false
```

*Everything else has sensible defaults or is only required for specific tasks.*

### Obtaining required API keys

• **The Graph**: Log in to [Subgraph Studio](https://thegraph.com/studio/apikeys/) → **API Keys** in the sidebar → *Create API Key* → copy the generated token. See the official guide for details ([docs](https://thegraph.com/docs/en/subgraphs/querying/managing-api-keys/)).

## API Endpoints

The server provides the following key endpoints:

- **`/updateVotes`**: Submit or update votes for liquidity pools (includes cooldown management)
- **`/claimAddress`**: Register Ethereum addresses for Bittensor hotkeys
- **`/weights`**: Retrieve final calculated miner weights
- **`/pools`**: Get current pool information and voting status
- **`/positions`**: Fetch Uniswap V3 liquidity positions for miners with USD values
- **`/voteCooldown/:address`**: Check voting cooldown status for an address
- **`/voteHistory/:address`**: View complete vote change history for an address
- **`/userVotes/:address`**: Get current votes for a specific address
- **`/allVotes`**: Retrieve all votes with token-based weight multipliers
- **`/allHolders`**: Get all token holders and their balances
- **`/allMiners`**: List all subnet miners with linked Ethereum addresses
- **`/ping`**: Version compatibility check for validators

### Key Features

#### Vote Cooldown Management
The system includes sophisticated cooldown management to prevent gaming:
- **Base cooldown**: 72 minutes after vote changes
- **Progressive system**: Cooldown doubles for frequent changes (72m → 144m → 288m → 576m)
- **Maximum cap**: 8 hours maximum cooldown
- **Reset mechanism**: 24 hours of inactivity resets to base cooldown
- **First-time voting**: No cooldown for new voters

#### Enhanced Position Data
Liquidity positions now include:
- Current token amounts and USD values
- CoinGecko price integration
- Automatic filtering of inactive positions
- Real-time emission calculations

#### Vote History & Transparency
- Complete audit trail of all vote changes
- Detailed cooldown timing information
- Change counting and progressive cooldown tracking

See `validator/api-server-docs.json` for complete API documentation.

## Version Management

The validator includes automatic version checking and update capabilities:

#### Environment Variables
- `AUTO_UPDATE_ENABLED`: Set to `true` to enable automatic updates (default: `false`)
- `TEST_MODE`: Set to `true` to run in test mode (default: `false`)
- `LOG`: Set to `true` to enable console logging (default: `false`)

#### Features
- **Periodic Version Checks**: Every 30 minutes, the validator pings the server to check version compatibility
- **12-Hour Timeout**: If version incompatibility persists for 12 hours, the validator automatically shuts down
- **Auto-Update**: When enabled, automatically pulls latest changes and restarts
- **Persistent Warnings**: Version warnings are saved locally and checked on startup
- **Graceful Degradation**: Version issues don't immediately stop the validator, allowing time for updates

## Contributing

PRs welcome – especially on optimisation of the weight formula, better docs, or additional scripts.

## License

MIT © 2025 creativebuilds