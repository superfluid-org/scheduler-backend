const { ethers } = require("ethers");
const {
    initProvider,
    initSigner,
    getNetwork,
    loadAllowlist,  // Make sure this is included
    loadState,
    syncState,
    processSchedulesWithAllowlist,
    ENFORCE_ALLOWLIST
} = require('./schedulerCommon');

const VestingSchedulerAbi = require("./abis/VestingSchedulerAbi.json");

const vSchedAddrOverride = process.env.VSCHED_ADDR;
const useV2 = process.env.USE_V2 ? process.env.USE_V2 === "true" : false;
const initStartBlockOverride = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined;
const endBlockOffset = process.env.END_BLOCK_OFFSET ? parseInt(process.env.END_BLOCK_OFFSET) : 30;
const logsQueryRangeOverride = process.env.LOGS_QUERY_RANGE ? parseInt(process.env.LOGS_QUERY_RANGE) : undefined;
const executionDelayS = process.env.EXECUTION_DELAY ? parseInt(process.env.EXECUTION_DELAY) : 0;

async function initVestingScheduler(network, provider) {
    const vSchedAddr = vSchedAddrOverride || (useV2 ? network.contractsV1.vestingSchedulerV2 : network.contractsV1.vestingScheduler);
    if (!vSchedAddr) {
        console.error(`No VestingScheduler${useV2 ? "V2" : ""} address provided or found in metadata for network ${network.name}`);
        console.error(`Network metadata:`, JSON.stringify(network, null, 2));
        throw new Error(`Missing VestingScheduler address for network ${network.name}`);
    }
    console.log(`Using VestingScheduler address: ${vSchedAddr}`);
    return new ethers.Contract(vSchedAddr, VestingSchedulerAbi, provider);
}

function getIndexOf(activeSchedules, superToken, sender, receiver) {
    return activeSchedules.findIndex(v => v.superToken === superToken && v.sender === sender && v.receiver === receiver);
}

const eventHandlers = {
    VestingScheduleCreated: (e, activeSchedules) => {
        const i = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (i >= 0) throw `schedule already exists for ${e.superToken} ${e.sender} ${e.receiver}`;
        activeSchedules.push({
            superToken: e.superToken,
            sender: e.sender,
            receiver: e.receiver,
            startDate: parseInt(e.startDate),
            endDate: parseInt(e.endDate),
            cliffDate: parseInt(e.cliffDate),
            startAmount: e.startAmount,
            receiver: e.receiver,
            cliffAmount: e.cliffAmount,
            flowRate: e.flowRate,
            userData: e.userData,
            started: false,
            stopped: false
        });
    },
    VestingScheduleUpdated: (e, activeSchedules) => {
        const i = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (i < 0) throw `schedule not found for ${e.superToken} ${e.sender} ${e.receiver}`;
        activeSchedules[i] = {
            ...activeSchedules[i],
            endDate: parseInt(e.endDate),
            cliffDate: parseInt(e.cliffDate),
            cliffAmount: e.cliffAmount,
            flowRate: e.flowRate,
            userData: e.userData
        };
    },
    VestingScheduleDeleted: (e, activeSchedules, removedSchedules) => {
        const i = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (i < 0) throw `schedule not found for ${e.superToken} ${e.sender} ${e.receiver}`;
        const removed = activeSchedules.splice(i, 1)[0];
        removedSchedules.push(removed);
    },
    VestingCliffAndFlowExecuted: (e, activeSchedules) => {
        const i = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (i < 0) throw `schedule not found for ${e.superToken} ${e.sender} ${e.receiver}`;
        activeSchedules[i].started = true;
    },
    VestingEndExecuted: (e, activeSchedules, removedSchedules) => {
        const i = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (i < 0) throw `schedule not found for ${e.superToken} ${e.sender} ${e.receiver}`;
        const removed = activeSchedules.splice(i, 1)[0];
        removed.stopped = true;
        removedSchedules.push(removed);
    },
    VestingEndFailed: (e, activeSchedules, removedSchedules) => {
        const i = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (i < 0) throw `schedule not found for ${e.superToken} ${e.sender} ${e.receiver}`;
        const removed = activeSchedules.splice(i, 1)[0];
        removed.stopped = true;
        removedSchedules.push(removed);
    }
};

async function processVestingSchedules(vSched, signer, activeSchedules, allowlist, chainId, blockTime, executionDelayS) {
    const toBeStarted = activeSchedules.filter(s => !s.started && s.startDate + executionDelayS <= blockTime);
    const toBeStopped = activeSchedules.filter(s => !s.stopped && s.endDate !== 0 && s.endDate + executionDelayS <= blockTime);

    console.log(`${toBeStarted.length} schedules to be started, ${toBeStopped.length} to be stopped`);

    await processSchedulesWithAllowlist(vSched, signer, toBeStarted, allowlist, chainId, processStart);
    await processSchedulesWithAllowlist(vSched, signer, toBeStopped, allowlist, chainId, processStop);
}

async function processStart(vSched, signer, s) {
    console.log(`processing{start} ${JSON.stringify(s, null, 2)}`);
    try {
        console.log(`+++ starting: ${s.superToken} ${s.sender} ${s.receiver}`);
        const estGasLimit = await vSched.executeVestingCliffAndFlow.estimateGas(s.superToken, s.sender, s.receiver, s.userData, { from: signer.address });
        const gasLimit = estGasLimit * BigInt(140) / BigInt(100); // increase by 40%
        const tx = await vSched.connect(signer).executeVestingCliffAndFlow(s.superToken, s.sender, s.receiver, s.userData, { gasLimit });
        console.log(`+++ waiting for tx ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
    } catch(e) {
        console.error(`### starting failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
    }
}

async function processStop(vSched, signer, s) {
    console.log(`processing{stop} ${JSON.stringify(s, null, 2)}`);
    try {
        console.log(`+++ stopping: ${s.superToken} ${s.sender} ${s.receiver}`);
        const estGasLimit = await vSched.executeVestingEnd.estimateGas(s.superToken, s.sender, s.receiver, s.userData, { from: signer.address });
        const gasLimit = estGasLimit * BigInt(140) / BigInt(100); // increase by 40%
        const tx = await vSched.connect(signer).executeVestingEnd(s.superToken, s.sender, s.receiver, s.userData, { gasLimit });
        console.log(`+++ waiting for tx ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
    } catch(e) {
        console.error(`### stopping failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
    }
}

async function run() {
    const { provider, chainId } = await initProvider();
    const signer = await initSigner(provider);
    const network = getNetwork(chainId);

    const vSched = await initVestingScheduler(network, provider);
    console.log(`init: using VestingScheduler${useV2 ? "V2" : ""} contract ${vSched.address}`);

    const stateFileName = `data/vestingschedules${useV2 ? "v2" : ""}_${network.name}.json`;
    const { startBlock, activeSchedules, removedSchedules } = await loadState(stateFileName, network, initStartBlockOverride);

    const endBlock = (await provider.getBlockNumber()) - endBlockOffset;
    const logsQueryRange = logsQueryRangeOverride || network.logsQueryRange;

    await syncState(vSched, startBlock, endBlock, logsQueryRange, activeSchedules, removedSchedules, eventHandlers, stateFileName);

    const blockTime = parseInt((await provider.getBlock()).timestamp);
    console.log(`*** blockTime: ${blockTime}, executionDelay: ${executionDelayS} s`);

    const allowlist = await loadAllowlist();

    await processVestingSchedules(vSched, signer, activeSchedules, allowlist, chainId, blockTime, executionDelayS);
}

run();
