const { ethers } = require("ethers");
const common = require('./schedulerCommon');
const VestingSchedulerAbi = require("./abis/VestingSchedulerAbi.json");
const VestingSchedulerV2Abi = require("./abis/VestingSchedulerV2Abi.json");
const VestingSchedulerV3Abi = require("./abis/VestingSchedulerV3Abi.json");

const vSchedAddrOverride = process.env.VSCHED_ADDR;
const contractVersion = process.env.CONTRACT_VERSION ? parseInt(process.env.CONTRACT_VERSION) : 1;
const initStartBlockOverride = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined;
const endBlockOffset = process.env.END_BLOCK_OFFSET ? parseInt(process.env.END_BLOCK_OFFSET) : 30;
const logsQueryRangeOverride = process.env.LOGS_QUERY_RANGE ? parseInt(process.env.LOGS_QUERY_RANGE) : undefined;
const executionDelayS = process.env.EXECUTION_DELAY ? parseInt(process.env.EXECUTION_DELAY) : 0;
const dataDir = process.env.DATA_DIR || "data";

let startDateValidAfter = 0;
let endDateValidBefore = 0;

function getAbiForVersion(version) {
    switch(version) {
        case 3: return VestingSchedulerV3Abi;
        case 2: return VestingSchedulerV2Abi;
        default: return VestingSchedulerAbi;
    }
}

function getContractAddressForVersion(network, version) {
    switch(version) {
        case 3: return network.contractsV1.vestingSchedulerV3;
        case 2: return network.contractsV1.vestingSchedulerV2;
        default: return network.contractsV1.vestingScheduler;
    }
}

async function initVestingScheduler(network, provider) {
    const vSchedAddr = vSchedAddrOverride || getContractAddressForVersion(network, contractVersion);
    if (!vSchedAddr) throw `no VestingScheduler${contractVersion > 1 ? `V${contractVersion}` : ""} address provided or found in metadata for network ${network.name}`;
    console.log(`Using VestingScheduler V${contractVersion} address: ${vSchedAddr}`);
    return new ethers.Contract(vSchedAddr, getAbiForVersion(contractVersion), provider);
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
        console.log(`CREATED ${JSON.stringify(e, null, 2)}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex >= 0) throw `schedule already exists for ${e.superToken} ${e.sender} ${e.receiver}`;

        activeSchedules.push({
            superToken: e.superToken,
            sender: e.sender,
            receiver: e.receiver,
            // start & end date tell us when to act
            startDate /*cliffAndFlowDate in contract*/: e.cliffDate == 0 ? e.startDate : e.cliffDate,
            endDate: e.endDate,
            // present only in v2. If set to non-zero, vesting starts by the receiver claiming
            claimValidityDate: e.claimValidityDate,
            // our meta state, to be updated by consecutive events
            started: false,
            stopped: false,
            failed: false
        });
    },
    VestingScheduleUpdated: (e, activeSchedules) => {
        // assert that the schedule exists
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex == -1) throw `trying to update schedule which doesn't exist: ${e.superToken} ${e.sender} ${e.receiver}`;
        const prevEndDate = activeSchedules[curIndex].endDate;

        activeSchedules[curIndex].endDate = e.endDate;
        console.log(`UPDATED: endDate ${e.endDate} for ${e.superToken} ${e.sender} ${e.receiver}`);
    },
    VestingScheduleDeleted: (e, activeSchedules, removedSchedules) => {
        console.log(`DELETED: ${JSON.stringify(e, null, 2)}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex == -1) throw `trying to delete schedule which doesn't exist: ${e.superToken} ${e.sender} ${e.receiver}`;

        removedSchedules.push(activeSchedules[curIndex]);
        activeSchedules.splice(curIndex, 1);
    },
    // This is also emitted when claiming
    VestingCliffAndFlowExecuted: (e, activeSchedules) => {
        console.log(`STARTED: ${e.superToken} ${e.sender} ${e.receiver}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex == -1) throw `trying to start schedule which doesn't exist: ${e.superToken} ${e.sender} ${e.receiver}`;

        activeSchedules[curIndex].started = true;
    },
    VestingEndExecuted: (e, activeSchedules, removedSchedules) => {
        console.log(`STOPPED: ${e.superToken} ${e.sender} ${e.receiver}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex == -1) throw `trying to stop schedule which doesn't exist: ${e.superToken} ${e.sender} ${e.receiver}`;

        activeSchedules[curIndex].stopped = true;
        removedSchedules.push(activeSchedules[curIndex]);
        activeSchedules.splice(curIndex, 1);
    },
    VestingEndFailed: (e, activeSchedules, removedSchedules) => {
        console.log(`FAILED: ${e.superToken} ${e.sender} ${e.receiver}`);
        const curIndex = getIndexOf(activeSchedules, e.superToken, e.sender, e.receiver);
        if (curIndex == -1) throw `trying to stop schedule which doesn't exist: ${e.superToken} ${e.sender} ${e.receiver}`;

        activeSchedules[curIndex].failed = true;
        removedSchedules.push(activeSchedules[curIndex]);
        activeSchedules.splice(curIndex, 1);
    }
};

async function processVestingSchedules(vSched, signer, activeSchedules, removedSchedules, allowlist, chainId, blockTime, executionDelayS) {
    // Remove schedules which we know won't be executable now or in the future
    for (let i = activeSchedules.length - 1; i >= 0; i--) {
        const s = activeSchedules[i];
        // claimable schedules not claimed in time for the flow to be started
        if (s.claimValidityDate > 0 && (blockTime > s.claimValidityDate || blockTime > s.endDate)) {
            console.log(`~~~ unclaimable or beyond end date: ${s.superToken} ${s.sender} ${s.receiver}`);
            removedSchedules.push(s);
            activeSchedules.splice(i, 1);
        // non-claimable schedules where the flow wasn't started
        } else if (s.claimValidityDate === 0 && !s.started && s.startDate + executionDelayS <= blockTime) {
            const dueSinceS = blockTime - s.startDate;
            if (dueSinceS > startDateValidAfter) {
                console.log(`~~~ start time window missed for ${s.superToken} ${s.sender} ${s.receiver} by ${dueSinceS - startDateValidAfter} s, removing`);
                removedSchedules.push(s);
                activeSchedules.splice(i, 1);
            }
        }
    }

    const toBeStarted = activeSchedules.filter(s => !s.started && s.startDate + executionDelayS <= blockTime
        && (s.claimValidityDate === undefined || s.claimValidityDate === 0));

    // regardless if claimable or not, we know that the `started` flag will be set if the flow is running and needs to be stopped by us
    const toBeStopped = activeSchedules.filter(s => s.started && !s.stopped && s.endDate !== 0 && s.endDate - endDateValidBefore + executionDelayS <= blockTime);

    console.log(`${toBeStarted.length} schedules to be started, ${toBeStopped.length} to be stopped`);

    await common.processSchedulesWithAllowlist(vSched, signer, toBeStarted, allowlist, chainId, processStart);
    await common.processSchedulesWithAllowlist(vSched, signer, toBeStopped, allowlist, chainId, processStop);
}

async function processStart(vSched, signer, s) {
    console.log(`processing{start} ${JSON.stringify(s, null, 2)}`);
    const blockTime = parseInt((await signer.provider.getBlock()).timestamp);
    const dueSinceS = blockTime - s.startDate;
    console.log(`dueSinceS: ${dueSinceS}`);
    if (dueSinceS > startDateValidAfter) {
        try {
            console.log(`+++ starting: ${s.superToken} ${s.sender} ${s.receiver}`);
            const receipt = await common.executeTx(vSched, signer, "executeCliffAndFlow", { superToken: s.superToken, sender: s.sender, receiver: s.receiver });
            console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
        } catch(e) {
            console.error(`### starting failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
        }
    }
}

async function processStop(vSched, signer, s) {
    console.log(`processing{stop} ${JSON.stringify(s, null, 2)}`);
    const blockTime = parseInt((await signer.provider.getBlock()).timestamp);
    // sanity check
    const curState = await vSched.getVestingSchedule(s.superToken, s.sender, s.receiver);
    if (s.endDate != parseInt(curState.endDate)) throw `state mismatch for ${s.superToken} ${s.sender} ${s.receiver} | contract endDate: ${curState.endDate.toString()}, persisted endDate ${curState.endDate}`;

    if (blockTime > s.endDate) {
        console.warn(`!!! stopping overdue, end time missed for ${s.superToken} ${s.sender} ${s.receiver} by ${blockTime - s.endDate} s !!!`);
    }
    try {
        console.log(`+++ stopping: ${s.superToken} ${s.sender} ${s.receiver}`);
        const receipt = await common.executeTx(vSched, signer, "executeEndVesting", { superToken: s.superToken, sender: s.sender, receiver: s.receiver });
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

        const vSched = await initVestingScheduler(network, provider);

        const stateFileName = `${dataDirOverride || dataDir}/vestingschedules-v${contractVersion}_${network.name}.json`;
        console.log(`Using state file: ${stateFileName}`);
        const { startBlock, activeSchedules, removedSchedules } = await common.loadState(stateFileName, network, initStartBlockOverride);

        const endBlock = (await provider.getBlockNumber()) - endBlockOffset;
        const logsQueryRange = logsQueryRangeOverride || network.logsQueryRange;

        await common.syncState(vSched, startBlock, endBlock, logsQueryRange, activeSchedules, removedSchedules, parseEvent, eventHandlers, stateFileName);

        const blockTime = parseInt((await provider.getBlock()).timestamp);
        startDateValidAfter = parseInt(await vSched.START_DATE_VALID_AFTER());
        endDateValidBefore = parseInt(await vSched.END_DATE_VALID_BEFORE());
        console.log(`*** blockTime: ${blockTime}, startDateValidAfter: ${startDateValidAfter}, endDateValidBefore: ${endDateValidBefore}, executionDelay: ${executionDelayS} s`);

        const allowlist = await common.loadAllowlist();

        await processVestingSchedules(vSched, signer, activeSchedules, removedSchedules, allowlist, chainId, blockTime, executionDelayS);
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
