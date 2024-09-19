const { ethers } = require("ethers");
const common = require('./schedulerCommon');
const WrapManagerAbi = require("./abis/WrapManagerAbi.json");

const wrapMgrAddrOverride = process.env.WRAP_MGR_ADDR;
const initStartBlockOverride = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined;
const endBlockOffset = process.env.END_BLOCK_OFFSET ? parseInt(process.env.END_BLOCK_OFFSET) : 30;
const logsQueryRangeOverride = process.env.LOGS_QUERY_RANGE ? parseInt(process.env.LOGS_QUERY_RANGE) : undefined;
const executionDelayS = process.env.EXECUTION_DELAY ? parseInt(process.env.EXECUTION_DELAY) : 0;
const dataDir = process.env.DATA_DIR || "data";

async function initWrapManager(network, provider) {
    const wrapMgrAddr = wrapMgrAddrOverride || network.contractsV1.autowrap.manager;
    if (!wrapMgrAddr) throw `no Autowrap Manager address provided or found in metadata for network ${network.name}`;
    console.log(`Using Wrap Manager address: ${wrapMgrAddr}`);
    return new ethers.Contract(wrapMgrAddr, WrapManagerAbi, provider);
}

function getIndexOf(activeSchedules, id) {
    return activeSchedules.findIndex(v => v.id === id);
}

function parseEvent(contract, event) {
    if (event.removed) throw "### removed flag true - handling for this is not implemented";

    const eventSignature = event.topics[0];
    const eventFragment = contract.interface.getEvent(eventSignature);
    const eventName = eventFragment.name;

    const parsedLog = contract.interface.parseLog(event);

    return {
        name: eventName,
        // field mandatory in all events
        id: parsedLog.args.id,
        // fields present in some events
        user: parsedLog.args.user !== undefined ? parsedLog.args.user : undefined,
        superToken: parsedLog.args.superToken !== undefined ? parsedLog.args.superToken : undefined,
        liquidityToken: parsedLog.args.liquidityToken !== undefined ? parsedLog.args.liquidityToken : undefined,
        strategy: parsedLog.args.strategy !== undefined ? parsedLog.args.strategy : undefined,
        expiry: parsedLog.args.expiry !== undefined ? parseInt(parsedLog.args.expiry) : undefined,
        lowerLimit: parsedLog.args.lowerLimit !== undefined ? parseInt(parsedLog.args.lowerLimit) : undefined,
        upperLimit: parsedLog.args.upperLimit !== undefined ? parseInt(parsedLog.args.upperLimit) : undefined,
        // metadata
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
    };
}

const eventHandlers = {
    WrapScheduleCreated: (e, activeSchedules) => {
        console.log(`CREATED ${JSON.stringify(e, null, 2)}`);
        const curIndex = getIndexOf(activeSchedules, e.id);
        if (curIndex >= 0) {
            console.log(`  UPDATE: already existed, overwriting...`);
            activeSchedules.splice(curIndex, 1);
        }

        activeSchedules.push({
            id: e.id,
            user: e.user,
            superToken: e.superToken,
            liquidityToken: e.liquidityToken,
            expiry: e.expiry,
            lowerLimit: e.lowerLimit,
            upperLimit: e.upperLimit,
            executionCounter: 0
        });
    },
    WrapScheduleDeleted: (e, activeSchedules, removedSchedules) => {
        console.log(`DELETED: ${JSON.stringify(e, null, 2)}`);
        const curIndex = getIndexOf(activeSchedules, e.id);
        if (curIndex == -1) throw `trying to delete schedule which doesn't exist: id ${e.id} (user ${e.user}, superToken ${e.superToken}, liquidityToken ${e.liquidityToken})`;
        removedSchedules.push(activeSchedules[curIndex]);
        activeSchedules.splice(curIndex, 1);
    },
    WrapExecuted: (e, activeSchedules) => {
        console.log(`EXECUTED: id ${e.id}`);
        const curIndex = getIndexOf(activeSchedules, e.id);
        if (curIndex == -1) throw `trying to flag as executed schedule which doesn't exist: ${e.id}`;
        activeSchedules[curIndex].executionCounter++;
        console.log(`  was executed ${activeSchedules[curIndex].executionCounter} times`);
    },
};

async function processWrapSchedules(wrapMgr, signer, activeSchedules, allowlist, chainId, blockTime) {
    const toBeExecuted = await Promise.all(activeSchedules.map(async sched => {
        const wrapAmount = await wrapMgr.checkWrapByIndex(sched.id);
        console.log(`wrapAmount for ${sched.id}: ${wrapAmount}`);
        return wrapAmount > 0 ? sched : null;
    }));

    const filteredToBeExecuted = toBeExecuted.filter(Boolean);
    console.log(`${filteredToBeExecuted.length} of ${activeSchedules.length} schedules to be executed`);

    await common.processSchedulesWithAllowlist(wrapMgr, signer, filteredToBeExecuted, allowlist, chainId, processExecute);
}

async function processExecute(wrapMgr, signer, s) {
    try {
        console.log(`+++ executing: id ${s.id} (user ${s.user}, superToken ${s.superToken}, liquidityToken ${s.liquidityToken})`);
        const receipt = await common.executeTx(wrapMgr, signer, "executeWrap", { user: s.user, superToken: s.superToken, liquidityToken: s.liquidityToken });
        console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
    } catch (e) {
        console.error(`### executing failed for ${s.superToken} ${s.user} ${s.liquidityToken}: ${e}`);
    }
}

async function run(customProvider, impersonatedSigner, dataDirOverride) {
    try {
        const { provider, chainId } = customProvider 
            ? { provider: customProvider, chainId: Number((await customProvider.getNetwork()).chainId) } 
            : await common.initProvider();
        
        const signer = impersonatedSigner || await common.initSigner(provider);
        const network = common.getNetwork(chainId);

        const wrapMgr = await initWrapManager(network, provider);

        const stateFileName = `${dataDirOverride || dataDir}/wrapschedules_${network.name}.json`;
        console.log(`Using state file: ${stateFileName}`);
        const { startBlock, activeSchedules, removedSchedules } = await common.loadState(stateFileName, network, initStartBlockOverride);

        const endBlock = (await provider.getBlockNumber()) - endBlockOffset;
        const logsQueryRange = logsQueryRangeOverride || network.logsQueryRange;

        await common.syncState(wrapMgr, startBlock, endBlock, logsQueryRange, activeSchedules, removedSchedules, parseEvent, eventHandlers, stateFileName);

        const blockTime = parseInt((await provider.getBlock()).timestamp);
        console.log(`*** blockTime: ${blockTime}, executionDelay: ${executionDelayS} s`);

        const allowlist = await common.loadAllowlist();

        await processWrapSchedules(wrapMgr, signer, activeSchedules, allowlist, chainId, blockTime);
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
