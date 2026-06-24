# Register a Bittensor public key with an EVM address
register:
  bun run scripts/register.ts

# Submit votes for liquidity pools
vote:
  bun run scripts/vote.ts

# Start the validator to process votes and submit weights
validate:
  bun run validator/index.ts

# Check current pool weights and rankings
pools:
  bun run scripts/pools.ts

# Display EVM balances for all keys
balance:
  NETWORK=mainnet bun run scripts/balance.ts

# Generate or import an EVM keypair
create-key:
  bun run scripts/create-key.ts

# Check if a Bittensor key is registered
check-key:
  bun run scripts/check-key.ts

# Calculate and display weight distributions
weights:
  bun run scripts/weights.ts

# Independently recompute miner weights and compare to the central API
verify-weights:
  bun run scripts/verify-weights.ts 