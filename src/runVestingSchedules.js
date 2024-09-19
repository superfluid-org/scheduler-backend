const { ethers } = require("ethers");
const common = require('./schedulerCommon');
const VestingSchedulerAbi = require("./abis/VestingSchedulerAbi.json");

const vSchedAddrOverride = process.env.VSCHED_ADDR;
const useV2 = process.env.USE_V2 ? process.env.USE_V2 === "true" : false;
const initStartBlockOverride = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined;
const endBlockOffset = process.env.END_BLOCK_OFFSET ? parseInt(process.env.END_BLOCK_OFFSET) : 30;
const logsQueryRangeOverride = process.env.LOGS_QUERY_RANGE ? parseInt(process.env.LOGS_QUERY_RANGE) : undefined;
const executionDelayS = process.env.EXECUTION_DELAY ? parseInt(process.env.EXECUTION_DELAY) : 0;
const dataDir = process.env.DATA_DIR || "data";

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
        cliffDate: parsedLog.args.cliffDate !== undefined ? parseInt(parsedLog.args.cliffDate) : undefined,
        endDate: parsedLog.args.endDate !== undefined ? parseInt(parsedLog.args.endDate) : undefined,
        claimValidityDate: parsedLog.args.claimValidityDate !== undefined ? parseInt(parsedLog.args.claimValidityDate) : undefined,
        // metadata
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
    };
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

    await common.processSchedulesWithAllowlist(vSched, signer, toBeStarted, allowlist, chainId, processStart);
    await common.processSchedulesWithAllowlist(vSched, signer, toBeStopped, allowlist, chainId, processStop);
}

async function processStart(vSched, signer, s) {
    console.log(`processing{start} ${JSON.stringify(s, null, 2)}`);
    try {
        console.log(`+++ starting: ${s.superToken} ${s.sender} ${s.receiver}`);
        const estGasLimit = await vSched.executeCliffAndFlow.estimateGas(s.superToken, s.sender, s.receiver, { from: signer.address });
        const gasLimit = estGasLimit * BigInt(140) / BigInt(100); // increase by 40%
        const tx = await vSched.connect(signer).executeCliffAndFlow(s.superToken, s.sender, s.receiver, { gasLimit });
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
        const estGasLimit = await vSched.executeEndVesting.estimateGas(s.superToken, s.sender, s.receiver, { from: signer.address });
        const gasLimit = estGasLimit * BigInt(140) / BigInt(100); // increase by 40%
        const tx = await vSched.connect(signer).executeEndVesting(s.superToken, s.sender, s.receiver, { gasLimit });
        console.log(`+++ waiting for tx ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
    } catch(e) {
        console.error(`### stopping failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
    }
}

async function run(customProvider, impersonatedSigner, dataDirOverride) {
    try {
        const { provider, chainId } = customProvider 
            ? { provider: customProvider, chainId: Number((await customProvider.getNetwork()).chainId) } 
            : await common.initProvider();
        
        const signer = impersonatedSigner || await common.initSigner(provider);
        const network = common.getNetwork(chainId);

        console.log(`init: network ${network.name}`);
        console.log(`init: signer account: ${await signer.getAddress()}`);

        const vSched = await initVestingScheduler(network, provider);

        const stateFileName = `${dataDirOverride || dataDir}/vestingschedules${useV2 ? "v2" : ""}_${network.name}.json`;
        console.log(`Using state file: ${stateFileName}`);
        const { startBlock, activeSchedules, removedSchedules } = await common.loadState(stateFileName, network, initStartBlockOverride);

        const endBlock = (await provider.getBlockNumber()) - endBlockOffset;
        const logsQueryRange = logsQueryRangeOverride || network.logsQueryRange;

        await common.syncState(vSched, startBlock, endBlock, logsQueryRange, activeSchedules, removedSchedules, parseEvent, eventHandlers, stateFileName);

        const blockTime = parseInt((await provider.getBlock()).timestamp);
        console.log(`*** blockTime: ${blockTime}, executionDelay: ${executionDelayS} s`);

        const allowlist = await common.loadAllowlist();

        await processVestingSchedules(vSched, signer, activeSchedules, allowlist, chainId, blockTime, executionDelayS);
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
