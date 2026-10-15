/**
 * Minimal Hardhat 3 config for Kurtosis v1.5 compile/upgrade.
 * Avoids hardhat-toolbox-mocha-ethers (missing peer on this checkout).
 */
import { defineConfig } from "hardhat/config";

const providerUrl = process.env.PROVIDER_URL ?? "http://127.0.0.1:32003";
const privateKey = process.env.PRIVATE_KEY
    ? (process.env.PRIVATE_KEY.startsWith("0x") ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`)
    : undefined;

export default defineConfig({
    solidity: {
        compilers: [
            {
                version: "0.8.30",
                settings: {
                    viaIR: false,
                    optimizer: { enabled: true, runs: 15_000 },
                },
            },
            {
                version: "0.7.6",
                settings: {
                    optimizer: { enabled: true, runs: 15_000 },
                },
            },
        ],
    },
    paths: {
        sources: "./contracts",
        cache: "./cache",
        artifacts: "./artifacts",
    },
    networks: {
        custom: {
            type: "http",
            chainType: "l1",
            url: providerUrl,
            accounts: privateKey ? [privateKey] : "remote",
        },
    },
});
