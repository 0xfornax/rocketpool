/**
 * Replace the verifier and megapool manager on an existing v1.5 devnet.
 * Compile the two contracts into artifacts-v15 first using deploy.sh's forge
 * settings. Requires guardian bootstrap mode and the current v1.5-dev network
 * contracts. Reads fork slots from CL_HTTP to match the running chain.
 *
 * PROVIDER_URL=http://127.0.0.1:32003 CL_HTTP=http://127.0.0.1:33101 \
 *   node scripts/devnet-7/redeploy-gloas-proofs.js
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const pako = require('pako');
const ROOT = path.resolve(__dirname, '../..');
const deploymentFile = process.env.DEPLOYMENT_FILE || path.join(ROOT, 'deployments/latest.json');

async function beacon(url, endpoint) {
    const response = await fetch(url + endpoint, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Beacon API ${endpoint}: HTTP ${response.status}`);
    return (await response.json()).data;
}

async function main() {
    const rpc = process.env.PROVIDER_URL;
    const cl = process.env.CL_HTTP;
    if (!rpc || !cl) throw new Error('PROVIDER_URL and CL_HTTP are required');
    const deployment = JSON.parse(fs.readFileSync(deploymentFile));
    const provider = new ethers.JsonRpcProvider(rpc);
    try {
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY || '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31', provider);
        const storageAddress = deployment.addresses.RocketStorage;
        const storage = new ethers.Contract(storageAddress, [
            'function getGuardian() view returns (address)',
            'function getAddress(bytes32) view returns (address)',
            'function getString(bytes32) view returns (string)',
        ], provider);
        const getAddress = storage.getFunction('getAddress(bytes32)');
        const version = await storage.getString(ethers.id('protocol.version'));
        if (version !== '1.5') throw new Error(`Expected protocol 1.5, found ${version}`);
        if ((await storage.getGuardian()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Signer is not guardian');
        const dao = new ethers.Contract(await getAddress(ethers.id('contract.addressrocketDAONodeTrusted')), [
            'function getBootstrapModeDisabled() view returns (bool)',
        ], provider);
        if (await dao.getBootstrapModeDisabled()) throw new Error('oDAO bootstrap is closed');
        // These consumers must already use the canonical versioned proof API.
        for (const [name, signature] of [
            ['rocketNetworkExit', 'penaliseMinipool(address,uint64,uint256,bytes)'],
            ['rocketNetworkParticipation', 'respondWithMegapoolValidator(uint256,uint32,uint64,uint256,bytes)'],
        ]) {
            const compressedAbi = await storage.getString(ethers.id('contract.abi' + name));
            const abi = JSON.parse(pako.inflate(Buffer.from(compressedAbi, 'base64'), { to: 'string' }));
            if (!new ethers.Interface(abi).hasFunction(signature)) {
                throw new Error(`${name} uses legacy proofs; upgrade the complete network to current v1.5-dev first`);
            }
        }
        const spec = await beacon(cl, '/eth/v1/config/spec');
        const slotsPerEpoch = BigInt(spec.SLOTS_PER_EPOCH);
        const forkSlots = ['ALTAIR','BELLATRIX','CAPELLA','DENEB','ELECTRA','FULU','GLOAS'].map(fork => {
            const epoch = BigInt(spec[`${fork}_FORK_EPOCH`]);
            return epoch === 2n ** 64n - 1n ? epoch : epoch * slotsPerEpoch;
        });
        const head = await beacon(cl, '/eth/v1/beacon/headers/head');
        if (BigInt(head.header.message.slot) < forkSlots[6]) throw new Error('Gloas is not active yet');
        const args = {
            BeaconStateVerifier: [storageAddress, BigInt(spec.SLOTS_PER_HISTORICAL_ROOT), forkSlots,
                '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02'],
            RocketMegapoolManager: [storageAddress],
        };
        const upgrade = new ethers.Contract(await getAddress(ethers.id('contract.addressrocketDAONodeTrustedUpgrade')), [
            'function bootstrapUpgrade(string,string,string,address)',
        ], wallet);
        const record = { source: 'v1.5-dev canonical Gloas proofs', rocketStorage: storageAddress,
            forkSlots: forkSlots.map(String), startedAt: new Date().toISOString(), contracts: {} };
        const snapshot = path.join(path.dirname(deploymentFile), `gloas_proofs_${Date.now()}.json`);
        const saveRecord = () => fs.writeFileSync(snapshot, JSON.stringify(record, null, 2));
        saveRecord();
        console.log(`Storage ${storageAddress}; fork slots ${record.forkSlots.join(',')}`);
        // Install the verifier first, then the manager that consumes its
        // canonical versioned bundle API.
        for (const name of Object.keys(args)) {
            const registryName = name[0].toLowerCase() + name.slice(1);
            const oldAddress = await getAddress(ethers.id('contract.address' + registryName));
            const artifact = JSON.parse(fs.readFileSync(path.join(process.env.V15_ARTIFACT_DIR || path.join(ROOT,'artifacts-v15'), name+'.sol',name+'.json')));
            const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
            const estimate = await wallet.estimateGas(await factory.getDeployTransaction(...args[name]));
            console.log(`Deploying ${name}; estimated gas ${estimate}`);
            const contract = await factory.deploy(...args[name], { gasLimit: estimate * 125n / 100n });
            await contract.waitForDeployment();
            const address = await contract.getAddress();
            if (await provider.getCode(address) === '0x') throw new Error(`No code at ${address}`);
            record.contracts[name] = { oldAddress, address, deploymentTx: contract.deploymentTransaction().hash };
            saveRecord();
            const abi = Buffer.from(pako.deflate(JSON.stringify(artifact.abi))).toString('base64');
            const upgradeArgs = ['upgradeContract',registryName,abi,address];
            const gas = await upgrade.bootstrapUpgrade.estimateGas(...upgradeArgs);
            const tx = await upgrade.bootstrapUpgrade(...upgradeArgs, {gasLimit: gas * 150n / 100n});
            record.contracts[name].registrationTx = tx.hash;
            saveRecord();
            await tx.wait();
            if ((await getAddress(ethers.id('contract.address'+registryName))).toLowerCase() !== address.toLowerCase()) throw new Error(`Registry mismatch for ${name}`);
            record.contracts[name].registered = true;
            saveRecord();
            deployment.addresses[name] = address;
            deployment.gloasProofUpgrade = record;
            fs.writeFileSync(deploymentFile,JSON.stringify(deployment,null,2));
            console.log(`${name}: ${oldAddress} -> ${address}; registered in ${tx.hash}`);
        }
        console.log(`Gloas proof redeployment complete. Record: ${snapshot}`);
    } finally { provider.destroy(); }
}
main().catch(error => {console.error(error);process.exitCode=1;});
