const fs = require("fs");
const { ethers } = require("ethers");
const sfMeta = require("@superfluid-finance/metadata");
const axios = require('axios');

const ALLOWLIST_URL = process.env.ALLOWLIST_URL || 'https://allowlist.superfluid.dev/api/_allowlist';
const ALLOWLIST_FILE = 'data/allowlist.json';
const ENFORCE_ALLOWLIST = process.env.ENFORCE_ALLOWLIST ? process.env.ENFORCE_ALLOWLIST === "true" : false;

// chainId to startBlock mapping for known deployments
const startBlockMapping = {
    100: 25992375, // xdai-mainnet
    137: 33383487, // polygon-mainnet
    10: 67820482,  // optimism-mainnet
    42161: 53448990, // arbitrum-one
    43114: 25012325, // avalanche-c
    1: 16418958,   // eth-mainnet
    8453: 13848318  // base-mainnet
};

async function initProvider() {
    const rpcUrl = process.env.RPC;
    if (!rpcUrl) throw "missing RPC env var";
    
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const chainId = parseInt((await provider.getNetwork()).chainId);
    console.log(`init: connected to network via RPC ${rpcUrl} with chainId ${chainId} at ${new Date()}`);
    
    return { provider, chainId };
}

const bigIntToStr = (key, value) => (typeof value === 'bigint' ? value.toString() : value);

async function initSigner(provider) {
    const privKey = process.env.PRIVKEY;
    if (!privKey) throw "missing PRIVKEY env var";
    
    const wallet = new ethers.Wallet(privKey);
    const signer = wallet.connect(provider);
    console.log(`init: signer account: ${signer.address}`);
    
    return signer;
}

function getNetwork(chainId) {
    console.log("ChainId type:", typeof chainId, "value:", chainId);
    const network = sfMeta.getNetworkByChainId(chainId);
    if (!network) throw `no network found for chainId ${chainId}`;
    console.log(`init: network ${network.name}`);
    return network;
}

async function fetchAllowlist() {
    try {
        const response = await axios.get(ALLOWLIST_URL);
        if (response.data && response.data.entries) {
            fs.writeFileSync(ALLOWLIST_FILE, JSON.stringify(response.data, null, 2));
            return response.data.entries;
        }
        throw new Error('Invalid allowlist data');
    } catch (error) {
        console.warn(`Failed to fetch allowlist: ${error.message}`);
        if (fs.existsSync(ALLOWLIST_FILE)) {
            console.log('Using previously saved allowlist');
            return JSON.parse(fs.readFileSync(ALLOWLIST_FILE)).entries;
        }
        throw new Error('No valid allowlist available');
    }
}

function isAllowed(account, chainId, allowlist) {
    const entry = allowlist.find(e => e.wallet.toLowerCase() === account.toLowerCase());
    return entry && entry.chains.includes(chainId);
}

async function loadState(stateFileName, network, initStartBlockOverride) {
    let startBlock = initStartBlockOverride || startBlockMapping[network.chainId] || network.startBlockV1;
    let activeSchedules = [];
    let removedSchedules = [];

    if (fs.existsSync(stateFileName)) {
        const state = JSON.parse(fs.readFileSync(stateFileName));
        console.log(`init: loaded state from file - lastBlock: ${state.lastBlock}, activeSchedules: ${state.activeSchedules.length}, removedSchedules: ${state.removedSchedules.length}`);
        startBlock = state.lastBlock + 1;
        activeSchedules = state.activeSchedules;
        removedSchedules = state.removedSchedules;
    } else {
        console.log(`!!! init: no state file ${stateFileName} found, starting from scratch`);
    }

    return { startBlock, activeSchedules, removedSchedules };
}

async function getEventsInRange(contract, event, start, end) {
    const filter = event;
    return await contract.queryFilter(filter, start, end);
}

function saveState(stateFileName, lastBlock, activeSchedules, removedSchedules) {
    fs.writeFileSync(stateFileName, JSON.stringify({
        lastBlock,
        activeSchedules,
        removedSchedules
    }, null, 2));
}

async function syncState(scheduler, startBlock, endBlock, logsQueryRange, activeSchedules, removedSchedules, parseEvent, eventHandlers, stateFileName) {
    for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += logsQueryRange) {
        const toBlock = Math.min(fromBlock + logsQueryRange - 1, endBlock);

        // Create a single array of topic filters
        const filters = await Promise.all(
            Object.keys(eventHandlers).map(async (eventName) => 
                await scheduler.filters[eventName]().getTopicFilter()
            )
        );
        // Flatten the inner arrays into a single array
        const filter = [filters.flat()];

        const newEvents = await scheduler.queryFilter(filter, fromBlock, toBlock);

        console.log(`*** query for past events from ${fromBlock} to ${toBlock} (of ${endBlock}) returned ${newEvents.length} events`);

        newEvents.forEach(e => {
            const parsedEvent = parseEvent(scheduler, e);
            console.log(`parsedEvent detail: ${JSON.stringify(parsedEvent, bigIntToStr, 2)}`);
            eventHandlers[parsedEvent.name](parsedEvent, activeSchedules, removedSchedules);
        });

        console.log(`*** have ${activeSchedules.length} schedules, ${removedSchedules.length} removed schedules`);
        saveState(stateFileName, toBlock, activeSchedules, removedSchedules);
    }
}

async function processSchedulesWithAllowlist(scheduler, signer, activeSchedules, allowlist, chainId, processFunction) {
    for (const schedule of activeSchedules) {
        if (!isAllowed(schedule.sender || schedule.user, chainId, allowlist)) {
            console.warn(`### Account ${schedule.sender || schedule.user} not in allowlist for chain ${chainId}`);
            if (ENFORCE_ALLOWLIST) continue;
        }
        await processFunction(scheduler, signer, schedule);
    }
}

async function loadAllowlist() {
    let allowlist = [];
    try {
        allowlist = await fetchAllowlist();
        console.log(`Fetched allowlist with ${allowlist.length} entries | allowlist enforcement: ${ENFORCE_ALLOWLIST}`);
    } catch (error) {
        if (ENFORCE_ALLOWLIST) {
            console.error(`Failed to fetch allowlist and enforcement is required: ${error.message}`);
            throw error;
        } else {
            console.warn(`Failed to fetch allowlist, but enforcement is not required. Proceeding with empty allowlist: ${error.message}`);
        }
    }
    return allowlist;
}

// returns the receipt
async function executeTx(contract, signer, methodName, params) {
    const method = contract[methodName];
    const estGasLimit = await method.estimateGas(...Object.values(params), { from: signer.address });
    const gasLimit = estGasLimit * BigInt(140) / BigInt(100); // increase by 40%
    const tx = await contract.connect(signer)[methodName](...Object.values(params), { gasLimit });
    console.log(`+++ waiting for tx ${tx.hash}`);
    return await tx.wait();
}

module.exports = {
    initProvider,
    initSigner,
    getNetwork,
    fetchAllowlist,
    isAllowed,
    loadState,
    getEventsInRange,
    saveState,
    ENFORCE_ALLOWLIST,
    syncState,
    processSchedulesWithAllowlist,
    loadAllowlist,
    executeTx
};
