const fs = require("fs");
const { ethers } = require("ethers");
const sfMeta = require("@superfluid-finance/metadata");
const axios = require('axios');

const ALLOWLIST_URL = process.env.ALLOWLIST_URL || 'https://allowlist.superfluid.dev/api/_allowlist';
const ALLOWLIST_FILE = 'data/allowlist.json';
const ENFORCE_ALLOWLIST = process.env.ENFORCE_ALLOWLIST ? process.env.ENFORCE_ALLOWLIST === "true" : false;

async function initProvider() {
    const rpcUrl = process.env.RPC;
    if (!rpcUrl) throw "missing RPC env var";
    
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const chainId = parseInt((await provider.getNetwork()).chainId);
    console.log(`init: connected to network via RPC ${rpcUrl} with chainId ${chainId} at ${new Date()}`);
    
    return { provider, chainId };
}

async function initSigner(provider) {
    const privKey = process.env.PRIVKEY;
    if (!privKey) throw "missing PRIVKEY env var";
    
    const wallet = new ethers.Wallet(privKey);
    const signer = wallet.connect(provider);
    console.log(`init: signer account: ${signer.address}`);
    
    return signer;
}

function getNetwork(chainId) {
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
    let startBlock = initStartBlockOverride || network.startBlockV1;
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

function parseEvent(contract, event) {
    if (event.removed) throw "### removed flag true - handling for this is not implemented";

    const eventSignature = event.topics[0];
    const eventFragment = contract.interface.getEvent(eventSignature);
    const eventName = eventFragment.name;

    const parsedLog = contract.interface.parseLog(event);

    return {
        name: eventName,
        ...parsedLog.args,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
    };
}

function saveState(stateFileName, lastBlock, activeSchedules, removedSchedules) {
    fs.writeFileSync(stateFileName, JSON.stringify({
        lastBlock,
        activeSchedules,
        removedSchedules
    }, null, 2));
}

async function syncState(scheduler, startBlock, endBlock, logsQueryRange, activeSchedules, removedSchedules, eventHandlers, stateFileName) {
    for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += logsQueryRange) {
        const toBlock = Math.min(fromBlock + logsQueryRange - 1, endBlock);

        const filters = Object.keys(eventHandlers).map(eventName => 
            scheduler.filters[eventName]()
        );

        let newEvents = [];
        for (const filter of filters) {
            const events = await scheduler.queryFilter(filter, fromBlock, toBlock);
            newEvents = newEvents.concat(events);
        }

        console.log(`*** query for past events from ${fromBlock} to ${toBlock} (of ${endBlock}) returned ${newEvents.length} events`);

        newEvents.forEach(e => {
            const parsedEvent = parseEvent(scheduler, e);
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

module.exports = {
    initProvider,
    initSigner,
    getNetwork,
    fetchAllowlist,
    isAllowed,
    loadState,
    getEventsInRange,
    parseEvent,
    saveState,
    ENFORCE_ALLOWLIST,
    syncState,
    processSchedulesWithAllowlist,
    loadAllowlist
};
