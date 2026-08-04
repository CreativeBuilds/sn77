require("@nomicfoundation/hardhat-toolbox");
require("hardhat-deploy");
const path = require("path");

// dotenv v17 is ESM-only; use createRequire to load config in CommonJS context
const { createRequire } = require('module');
const _require = createRequire(import.meta ? import.meta.url : __filename);
try {
  // Preferred: load via the dotenv/config entry point with process.env overrides
  const dotenv = _require('dotenv');
  dotenv.config({
    path: path.resolve(process.cwd(), process.env.HARDHAT_NETWORK === 'bittensorLocal' ? '.env.local' : '.env'),
    override: true
  });
} catch (e) {
  // Fallback: manually load dotenv if module resolution fails
  console.warn('dotenv config load failed:', e.message);
}

// if(!process.env.ETH_SIGN_KEY) {
//   throw new Error("ETH_SIGN_KEY is not set");
// }
// if(!process.env.ETH_LP_KEY) {
//   throw new Error("ETH_LP_KEY is not set");
// }


/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  defaultNetwork: "bittensorMainnet",
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
  networks: {
    hardhat: {
      // Default Hardhat network config
    },
  },
};
