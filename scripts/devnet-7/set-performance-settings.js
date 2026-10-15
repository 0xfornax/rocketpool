/**
 * Configure performance challenges on the local devnet while pDAO bootstrap is open.
 *
 * PROVIDER_URL=http://127.0.0.1:32003 node scripts/devnet-7/set-performance-settings.js
 * PERFORMANCE_PERIOD_EPOCHS defaults to 16.
 * PERFORMANCE_RESPONSE_WINDOW_SECS defaults to 1800 (30 minutes).
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

async function setPerformanceSettings(provider, signer, rocketStorage) {
    const period = BigInt(process.env.PERFORMANCE_PERIOD_EPOCHS || '16');
    const responseWindow = BigInt(process.env.PERFORMANCE_RESPONSE_WINDOW_SECS || '1800');
    if (period <= 0n || responseWindow <= 0n) {
        throw new Error('Performance period and response window must be positive');
    }
    const storage = new ethers.Contract(rocketStorage, [
        'function getAddress(bytes32) view returns (address)',
        'function getGuardian() view returns (address)',
    ], provider);
    const getAddress = storage.getFunction('getAddress(bytes32)');
    const settingsName = 'rocketDAOProtocolSettingsNetwork';
    const settings = new ethers.Contract(await getAddress(ethers.id('contract.address' + settingsName)), [
        'function getPerformancePeriod() view returns (uint256)',
        'function getPerformanceChallengePeriod() view returns (uint256)',
    ], provider);
    const dao = new ethers.Contract(await getAddress(ethers.id('contract.addressrocketDAOProtocol')), [
        'function getBootstrapModeDisabled() view returns (bool)',
        'function bootstrapSettingUint(string,string,uint256)',
    ], signer);
    const changes = [
        ['network.performance.period', 'getPerformancePeriod', period, 'epochs'],
        ['network.performance.challenge.period', 'getPerformanceChallengePeriod', responseWindow, 'seconds'],
    ];
    for (const [settingPath, getter, target, unit] of changes) {
        const current = await settings[getter]();
        if (current === target) {
            console.log(`  ${settingPath} already ${target} ${unit}`);
            continue;
        }
        if ((await storage.getGuardian()).toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
            throw new Error('Signer is not the guardian');
        }
        if (await dao.getBootstrapModeDisabled()) throw new Error('pDAO bootstrap is closed');
        const args = [settingsName, settingPath, target];
        const estimate = await dao.bootstrapSettingUint.estimateGas(...args);
        console.log(`  ${settingPath}: ${current} -> ${target} ${unit}`);
        const buffered = estimate * 150n / 100n;
        const tx = await dao.bootstrapSettingUint(...args, { gasLimit: buffered > 300000n ? buffered : 300000n });
        await tx.wait();
        if (await settings[getter]() !== target) throw new Error(`${settingPath} did not update`);
        console.log(`    verified ${tx.hash}`);
    }
}

async function main() {
    const deploymentFile = process.env.DEPLOYMENT_FILE || path.resolve(__dirname, '../../deployments/latest.json');
    const deployment = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));
    const provider = new ethers.JsonRpcProvider(process.env.PROVIDER_URL || 'http://127.0.0.1:32003');
    try {
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY || '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31', provider);
        await setPerformanceSettings(provider, wallet, deployment.addresses.RocketStorage);
    } finally {
        provider.destroy();
    }
}

module.exports = { setPerformanceSettings };
if (require.main === module) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
