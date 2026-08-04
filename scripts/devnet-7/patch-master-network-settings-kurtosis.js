/**
 * Kurtosis-only patches for protocol settings in the baseline worktree.
 *
 * Network (RocketDAOProtocolSettingsNetwork.sol):
 *   - Default prices/balances submit frequency: 1 day → 300s
 *   - Guardrail min for balances.frequency: 1 hour → 300s
 *
 * Rewards (RocketDAOProtocolSettingsRewards.sol, optional 2nd arg or sibling path):
 *   - Default rewards.claims periods: 28 → 4
 *     (interval time = periods × balances.frequency = 4 × 300s = 20 minutes)
 *
 * Usage:
 *   node scripts/devnet-7/patch-master-network-settings-kurtosis.js \
 *     /path/to/worktree/contracts/contract/dao/protocol/settings/RocketDAOProtocolSettingsNetwork.sol \
 *     [/path/to/worktree/.../RocketDAOProtocolSettingsRewards.sol]
 */
const fs = require('fs');
const path = require('path');

const networkTarget = process.argv[2];
if (!networkTarget || !fs.existsSync(networkTarget)) {
    console.error(
        'Usage: node patch-master-network-settings-kurtosis.js <SettingsNetwork.sol> [SettingsRewards.sol]',
    );
    process.exit(1);
}

let rewardsTarget = process.argv[3];
if (!rewardsTarget) {
    // Same settings directory as Network
    const sibling = path.join(path.dirname(networkTarget), 'RocketDAOProtocolSettingsRewards.sol');
    if (fs.existsSync(sibling)) rewardsTarget = sibling;
}

function patchNetwork(file) {
    let src = fs.readFileSync(file, 'utf8');
    let n = 0;

    const reBal = /_setSettingUint\(\s*"network\.submit\.balances\.frequency"\s*,\s*1 days\s*\)/;
    const rePri = /_setSettingUint\(\s*"network\.submit\.prices\.frequency"\s*,\s*1 days\s*\)/;
    if (reBal.test(src)) {
        src = src.replace(reBal, '_setSettingUint("network.submit.balances.frequency", 300)');
        n++;
        console.log('  Network defaults: balances.frequency → 300s');
    }
    if (rePri.test(src)) {
        src = src.replace(rePri, '_setSettingUint("network.submit.prices.frequency", 300)');
        n++;
        console.log('  Network defaults: prices.frequency → 300s');
    }

    const reGuard = /require\(\s*_value\s*>=\s*1 hours\s*&&\s*_value\s*<=\s*7 days\s*,\s*"Value must be >= 1 hour & <= 7 days"\s*\)/;
    if (reGuard.test(src)) {
        src = src.replace(
            reGuard,
            'require(_value >= 300 && _value <= 7 days, "Value must be >= 300 seconds & <= 7 days")',
        );
        n++;
        console.log('  Network guardrail: balances.frequency min → 300s');
    }

    if (n === 0) {
        if (src.includes('network.submit.balances.frequency", 300')) {
            console.log(`  Network already Kurtosis-patched: ${file}`);
            return;
        }
        console.error(`No Network frequency patterns matched in ${file}`);
        process.exit(1);
    }
    fs.writeFileSync(file, src);
    console.log(`  Wrote ${file} (${n} change(s))`);
}

function patchRewards(file) {
    let src = fs.readFileSync(file, 'utf8');
    // constructor: setUint(..., "rewards.claims", "periods"), 28)
    const re = /setUint\(\s*keccak256\(\s*abi\.encodePacked\(\s*settingNameSpace\s*,\s*"rewards\.claims"\s*,\s*"periods"\s*\)\s*\)\s*,\s*28\s*\)/;
    if (re.test(src)) {
        src = src.replace(
            re,
            'setUint(keccak256(abi.encodePacked(settingNameSpace, "rewards.claims", "periods")), 4)',
        );
        fs.writeFileSync(file, src);
        console.log('  Rewards defaults: claims periods 28 → 4 (×300s = 20 min interval)');
        console.log(`  Wrote ${file}`);
        return;
    }
    // Accept prior Kurtosis patches (2/6) or current default (4 → 20 min).
    if (src.includes('"rewards.claims", "periods")), 4)')
        || src.includes('"rewards.claims", "periods"), 4)')
        || src.includes('"rewards.claims", "periods")), 6)')
        || src.includes('"rewards.claims", "periods"), 6)')
        || src.includes('"rewards.claims", "periods")), 2)')
        || src.includes('"rewards.claims", "periods"), 2)')) {
        console.log(`  Rewards already Kurtosis-patched: ${file}`);
        return;
    }
    console.error(`No Rewards periods default matched in ${file}`);
    process.exit(1);
}

console.log('Kurtosis protocol settings patch:');
patchNetwork(networkTarget);
if (rewardsTarget) {
    patchRewards(rewardsTarget);
} else {
    console.log('  (no SettingsRewards.sol path; skip periods default)');
}
