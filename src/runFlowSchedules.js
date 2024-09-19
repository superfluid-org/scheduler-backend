const { ethers } = require("ethers");
const common = require('./schedulerCommon');
const FlowSchedulerAbi = require("./abis/FlowSchedulerAbi.json");

const fSchedAddrOverride = process.env.FSCHED_ADDR;
const initStartBlockOverride = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined;
const endBlockOffset = process.env.END_BLOCK_OFFSET ? parseInt(process.env.END_BLOCK_OFFSET) : 30;
const logsQueryRangeOverride = process.env.LOGS_QUERY_RANGE ? parseInt(process.env.LOGS_QUERY_RANGE) : undefined;
const executionDelayS = process.env.EXECUTION_DELAY ? parseInt(process.env.EXECUTION_DELAY) : 0;
const dataDir = process.env.DATA_DIR || "data";

async function initFlowScheduler(network, provider) {
    const fSchedAddr = fSchedAddrOverride || network.contractsV1.flowScheduler;
    if (!fSchedAddr) {
        console.error(`No FlowScheduler address provided or found in metadata for network ${network.name}`);
        console.error(`Network metadata:`, JSON.stringify(network, null, 2));
        throw new Error(`Missing FlowScheduler address for network ${network.name}`);
    }
    console.log(`Using FlowScheduler address: ${fSchedAddr}`);

    return new ethers.Contract(fSchedAddr, FlowSchedulerAbi, provider);
}

function getIndexOf(activeSchedules, superToken, sender, receiver) {
    return activeSchedules.findIndex(v => v.superToken === superToken && v.sender === sender && v.receiver === receiver);
}

function parseEvent(contract, event) {
    if (event.removed) throw "### removed flag true - handling for this is not implemented";

    const eventSignature = event.topics[0];
    const eventFragment = contract.interface.getEvent(eventSignature);
    const eventName = eventFragment.name;

    const parsedLog = contract.interface.parseLog(event);

    return {
        name: eventName,
        // mandatory in all events
        superToken: parsedLog.args.superToken,
        sender: parsedLog.args.sender,
        receiver: parsedLog.args.receiver,
        // in some events
        startDate: parsedLog.args.startDate !== undefined ? parseInt(parsedLog.args.startDate) : undefined,
        endDate: parsedLog.args.endDate !== undefined ? parseInt(parsedLog.args.endDate) : undefined,
        userData: parsedLog.args.userData !== undefined ? parsedLog.args.userData : undefined,
        // metadata
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
    };
}

const eventHandlers = {
    FlowScheduleCreated: (e, activeSchedules) => {
        console.log(`CREATED ${JSON.stringify(e, null, 2)}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex >= 0) {
            // Overwrite the existing schedule
            console.warn(`UPDATE: Schedule already exists for ${e.superToken} ${e.sender} ${e.receiver}. Overwriting...`);
            activeSchedules.splice(curIndex, 1);
        }

        activeSchedules.push({
            superToken: e.superToken,
            sender: e.sender,
            receiver: e.receiver,
            // start & end date tell us when to act
            startDate: e.startDate,
            endDate: e.endDate,
            userData: e.userData,
            // our meta state, to be updated by consecutive events
            started: false,
            stopped: false,
            failed: false
        });
    },
    FlowScheduleDeleted: (e, activeSchedules, removedSchedules) => {
        console.log(`DELETED: ${JSON.stringify(e, null, 2)}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex === -1) {
            console.warn(`DELETE: Attempted to delete a non-existent schedule for ${e.superToken} ${e.sender} ${e.receiver}`);
            return;
        }

        removedSchedules.push(activeSchedules[curIndex]);
        activeSchedules.splice(curIndex, 1);
    },
    CreateFlowExecuted: (e, activeSchedules) => {
        console.log(`STARTED: ${e.superToken} ${e.sender} ${e.receiver}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex === -1) throw `trying to start schedule which doesn't exist: ${e.superToken} ${e.sender} ${e.receiver}`;

        activeSchedules[curIndex].started = true;
    },
    DeleteFlowExecuted: (e, activeSchedules, removedSchedules) => {
        console.log(`STOPPED: ${e.superToken} ${e.sender} ${e.receiver}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex === -1) {
            console.warn(`DELETE EXECUTE: Attempted to execute deleteFlow on a non-existent schedule for ${e.superToken} ${e.sender} ${e.receiver}`);
            return;
        }

        activeSchedules[curIndex].stopped = true;
        removedSchedules.push(activeSchedules[curIndex]);
        activeSchedules.splice(curIndex, 1);
    }
};

async function processFlowSchedules(fSched, signer, activeSchedules, allowlist, chainId, blockTime, executionDelayS) {
    const toBeStarted = activeSchedules.filter(s => !s.started && s.startDate + executionDelayS <= blockTime);
    const toBeStopped = activeSchedules.filter(s => !s.stopped && s.endDate !== 0 && s.endDate + executionDelayS <= blockTime);

    console.log(`${toBeStarted.length} flows to be started, ${toBeStopped.length} flows to be stopped`);

    await common.processSchedulesWithAllowlist(fSched, signer, toBeStarted, allowlist, chainId, processStart);
    await common.processSchedulesWithAllowlist(fSched, signer, toBeStopped, allowlist, chainId, processStop);
}

async function processStart(fSched, signer, s) {
    try {
        console.log(`+++ starting flow: ${s.superToken} ${s.sender} ${s.receiver}`);
        const receipt = await common.executeTx(fSched, signer, "executeCreateFlow", { superToken: s.superToken, sender: s.sender, receiver: s.receiver, userData: s.userData });
        console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
    } catch (e) {
        console.error(`### starting flow failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
    }
}

async function processStop(fSched, signer, s) {
    try {
        console.log(`+++ stopping flow: ${s.superToken} ${s.sender} ${s.receiver}`);
        const receipt = await common.executeTx(fSched, signer, "executeDeleteFlow", { superToken: s.superToken, sender: s.sender, receiver: s.receiver, userData: s.userData });
        console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
    } catch (e) {
        console.error(`### stopping flow failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
    }
}

async function run(customProvider, impersonatedSigner, dataDirOverride) {
    try {
        const { provider, chainId } = customProvider 
            ? { provider: customProvider, chainId: Number((await customProvider.getNetwork()).chainId) } 
            : await common.initProvider();
        
        const signer = impersonatedSigner || await common.initSigner(provider);
        const network = common.getNetwork(chainId);

        const fSched = await initFlowScheduler(network, provider);

        const stateFileName = `${dataDirOverride || dataDir}/flowschedules_${network.name}.json`;
        console.log(`Using state file: ${stateFileName}`);
        const { startBlock, activeSchedules, removedSchedules } = await common.loadState(stateFileName, network, initStartBlockOverride);

        const endBlock = (await provider.getBlockNumber()) - endBlockOffset;
        const logsQueryRange = logsQueryRangeOverride || network.logsQueryRange;

        await common.syncState(fSched, startBlock, endBlock, logsQueryRange, activeSchedules, removedSchedules, parseEvent, eventHandlers, stateFileName);

        const blockTime = parseInt((await provider.getBlock()).timestamp);
        console.log(`*** blockTime: ${blockTime}, executionDelay: ${executionDelayS} s`);

        const allowlist = await common.loadAllowlist();

        await processFlowSchedules(fSched, signer, activeSchedules, allowlist, chainId, blockTime, executionDelayS);
    } catch (error) {
        console.error("Error in run function:", error);
        throw error;
    }
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };