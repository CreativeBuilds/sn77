require("@nomicfoundation/hardhat-toolbox");
require("hardhat-deploy");
require("hardhat-deploy-ethers");
const path = require("path");

require("dotenv").config({
  path: path.resolve(process.cwd(), process.env.HARDHAT_NETWORK === 'bittensorLocal' ? '.env.local' : '.env'),
  override: true
});

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
