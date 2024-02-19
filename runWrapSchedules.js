const fs = require("fs");
const { ethers } = require("ethers");
const sfMeta = require("@superfluid-finance/metadata")
const WrapManagerAbi = require("./WrapManagerAbi.json");

const privKey = process.env.PRIVKEY;
if (!privKey) throw "missing PRIVKEY env var";

const rpcUrl = process.env.RPC;
if (!rpcUrl) throw "missing RPC env var";

const wrapMgrAddrOverride = process.env.WRAPMGR_ADDR; // default: get from metadata

// where to start when no state is persisted. Defaults to protocol deployment block
// which can be long before scheduler contract deployment, thus take unnecessarily long to bootstrap.
const initStartBlockOverride = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined;

// margin to end block in order to avoid reorgs (which aren't handled)
// caution: this can cause state mismatch if the next run occurs before the chain advances by <offset> blocks
const endBlockOffset = process.env.END_BLOCK_OFFSET ? parseInt(process.env.END_BLOCK_OFFSET) : 30;

const logsQueryRangeOverride = process.env.LOGS_QUERY_RANGE ? parseInt(process.env.LOGS_QUERY_RANGE) : undefined;

const executionDelayS = process.env.EXECUTION_DELAY ? parseInt(process.env.EXECUTION_DELAY) : 0;


async function run() {
    // =====================================
    // init
    // =====================================

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const chainId = parseInt((await provider.getNetwork()).chainId);
    console.log(`init: connected to network via RPC ${rpcUrl} with chainId ${chainId} at ${new Date()}`);

    const network = sfMeta.getNetworkByChainId(chainId);
    if (!network) throw `no network found for chainId ${chainId}`;
    console.log(`init: network ${network.name}`);
    if (!network.contractsV1.autowrap) throw `no autowrap contract found in metadata for network ${network.name}`;

    const wallet = new ethers.Wallet(privKey);
    const signer = wallet.connect(provider);

    console.log(`init: signer account: ${signer.address}`);

    const wrapMgrAddr = wrapMgrAddrOverride || network.contractsV1.autowrap.manager;
    if (!wrapMgrAddr) throw `no Autowrap Manager address provided or found in metadata for network ${network.name}`;
    const wrapMgr = new ethers.Contract(wrapMgrAddr, WrapManagerAbi, provider);

    // relevant only when starting from scratch, without persisted state
    let startBlock = initStartBlockOverride || network.startBlockV1;
    let activeSchedules = [];
    let removedSchedules = [];

    // load persisted state
    const stateFileName = `data/wrapschedules_${network.name}.json`;
    if (fs.existsSync(stateFileName)) {
        const state = JSON.parse(fs.readFileSync(stateFileName));
        console.log(`init: loaded state from file - startBlock: ${state.lastBlock}, activeSchedules: ${state.activeSchedules.length}, removedSchedules: ${state.removedSchedules.length}`);
        startBlock = state.lastBlock;
        activeSchedules = state.activeSchedules;
        removedSchedules = state.removedSchedules;
    } else {
        console.log(`!!! init: no state file ${stateFileName} found, starting from scratch`);
    }

    console.log(`init: using Wrap Manager contract ${wrapMgrAddr}`);

    // =====================================
    // sync local state with contract state
    // =====================================

    async function getEventsInRange(event, start, end) {
        const filter = event;
        return await wrapMgr.queryFilter(filter, start, end);
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
            // the app as is could still work if we track just the id
            id: parsedLog.args.id,

            // fields present in some events
            // this 3 together identify a schedule (and determine the id)
            // id = keccak256(abi.encode(user, superToken, liquidityToken));
            // we parse and keep them for more readable logs
            user: parsedLog.args.user !== undefined ? parsedLog.args.user : undefined,
            superToken: parsedLog.args.superToken !== undefined ? parsedLog.args.superToken : undefined,
            liquidityToken: parsedLog.args.liquidityToken !== undefined ? parsedLog.args.liquidityToken : undefined,

            // none of those we really need, but retaining them is cheap and may be useful one day.
            strategy: parsedLog.args.strategy !== undefined ? parsedLog.args.strategy : undefined,
            expiry: parsedLog.args.expiry !== undefined ? parseInt(parsedLog.args.expiry) : undefined,
            lowerLimit: parsedLog.args.lowerLimit !== undefined ? parseInt(parsedLog.args.lowerLimit) : undefined,
            upperLimit: parsedLog.args.upperLimit !== undefined ? parseInt(parsedLog.args.upperLimit) : undefined,

            // metadata
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
        };
    }

    const endBlock = (await provider.getBlockNumber()) - endBlockOffset;
    const logsQueryRange = logsQueryRangeOverride || network.logsQueryRange;
    if (endBlock < startBlock) throw `endBlock ${endBlock} < startBlock ${startBlock}`;
    console.log(`*** query for past events from ${startBlock} to ${endBlock} (delta: ${endBlock - startBlock}) with logs query range ${logsQueryRange} ...`);

    function getIndexOf(id) {
        return activeSchedules.findIndex(v => v.id === id);
    }

    // classic iteration over range queries for logs, usually done in a few mins with a "close" RPC
    for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += logsQueryRange) {
        const toBlock = Math.min(fromBlock + logsQueryRange - 1, endBlock);

        const topicFilter = [
            (await wrapMgr.filters.WrapScheduleCreated().getTopicFilter())
            .concat(await wrapMgr.filters.WrapScheduleDeleted().getTopicFilter())
            .concat(await wrapMgr.filters.WrapExecuted().getTopicFilter())
        ];

        const newEvents = await getEventsInRange(topicFilter, fromBlock, toBlock);
        console.log(`*** query for past events from ${fromBlock} to ${toBlock} (of ${endBlock}) returned ${newEvents.length} events`);

        const eventHandlerFunctions = {
            handleWrapScheduleCreated: function(e) {
                //console.log(`created event ${JSON.stringify(e, null, 2)}`);
                const parsedEvent = parseEvent(wrapMgr, e);

                console.log(`CREATED ${JSON.stringify(parsedEvent, null, 2)}`);
                const curIndex = getIndexOf(parsedEvent.id);
                if (curIndex >= 0) {
                    // the contract allows to call createWrapSchedule() again and treats it as update
                    console.log(`  UPDATE: already existed, overwriting...`);
                    // delete from active schedules, so we can just add with the new values witout creating a duplicate
                    activeSchedules.splice(curIndex, 1);
                }

                // we define our own custom data structure for vesting schedules, containing just what we need
                activeSchedules.push({
                    id: parsedEvent.id,
                    // those 3 together also identify a schedule
                    user: parsedEvent.user,
                    superToken: parsedEvent.superToken,
                    liquidityToken: parsedEvent.liquidityToken,
                    // also
                    expiry: parsedEvent.expiry,
                    lowerLimit: parsedEvent.lowerLimit,
                    upperLimit: parsedEvent.upperLimit,
                    // our meta state, to be updated by consecutive events
                    // TODO: which states do we need for autowrap?
                    executionCounter: 0
                });
            },

            handleWrapScheduleDeleted: function(e) {
                const parsedEvent = parseEvent(wrapMgr, e);
                console.log(`DELETED: ${JSON.stringify(parsedEvent, null, 2)}`);
                const curIndex = getIndexOf(parsedEvent.id);
                if (curIndex == -1) throw `trying to delete schedule which doesn't exist: id ${parsedEvent.id} (user ${parsedEvent.user}, superToken ${parsedEvent.superToken}, liquidityToken ${parsedEvent.liquidityToken})`;
                removedSchedules.push(activeSchedules[curIndex]);
                activeSchedules.splice(curIndex, 1);
            },

            // this only has logging purpose
            handleWrapExecuted: function(e) {
                const parsedEvent = parseEvent(wrapMgr, e);
                console.log(`EXECUTED: id ${parsedEvent.id}`);
                const curIndex = getIndexOf(parsedEvent.id);
                if (curIndex == -1) throw `trying to flag as executed schedule which doesn't exist: ${parsedEvent.id}`;
                activeSchedules[curIndex].executionCounter++;
                console.log(`  was executed ${activeSchedules[curIndex].executionCounter} times`);
            },
        };

        newEvents.forEach(e => {
            //console.log(`new event ${JSON.stringify(e, null, 2)}`);
            const parsedEvent = parseEvent(wrapMgr, e);
            //console.log(`parsed event ${JSON.stringify(parsedEvent, null, 2)}`);
            eventHandlerFunctions[`handle${parsedEvent.name}`](e);
        });

        console.log(`*** have ${activeSchedules.length} schedules, ${removedSchedules.length} removed schedules`);

        // persist state before going on to execution
        fs.writeFileSync(stateFileName, JSON.stringify({
            lastBlock: toBlock,
            activeSchedules,
            removedSchedules
        }, null, 2));
    }

    // =====================================
    // do what needs to be done
    // =====================================

    const blockTime = parseInt((await provider.getBlock()).timestamp);
    console.log(`*** blockTime: ${blockTime}, executionDelay: ${executionDelayS} s`);

    // in order to get the list of wrap actions to be executed, iterate through the active schedules
    // and for each check if an execution is due.
    // TODO: this parallel loop will eventually need throttling if the list of schedules grows large
    const toBeExecuted = (await Promise.all(activeSchedules.map(async sched => {
        const wrapAmount = await wrapMgr.checkWrapByIndex(sched.id);
        console.log(`wrapAmount for ${sched.id}: ${wrapAmount}`);
        return wrapAmount > 0 ? sched : null;
    }))).filter(Boolean); // remove null items

    //console.log(`toBeExecuted: ${JSON.stringify(toBeExecuted, null, 2)}`);
    console.log(`${toBeExecuted.length} of ${activeSchedules.length} schedules to be executed`);

    for (let i = 0; i < toBeExecuted.length; i++) {
        const s = toBeExecuted[i];
        console.log(`processing{execute} ${JSON.stringify(s, null, 2)}`);

        // TODO: may want to do a sanity check here. But doesn't really make a difference (other than for debugging purposes)
        //const curState = await wrapMgr.getWrapSchedule(s.user, s.superToken, s.liquidityToken);

        try {
            console.log(`+++ executing: id ${s.id} (user ${s.user}, superToken ${s.superToken}, liquidityToken ${s.liquidityToken})`);
            // could use executeWrapByIndex here instead if we want to get more minimalistic
            const estGasLimit = await wrapMgr.executeWrap.estimateGas(s.user, s.superToken, s.liquidityToken, { from: signer.address });
            const gasLimit = estGasLimit * BigInt(140) / BigInt(100); // increase by 40%
            console.log(`+++ estimated gas limit: ${estGasLimit}, using ${gasLimit}`);

            const tx = await wrapMgr.connect(signer).executeWrap(s.user, s.superToken, s.liquidityToken, { gasLimit });
            console.log(`+++ waiting for tx ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
            // we don't change the local state, but rely on resulting events parsed when running next
        } catch(e) {
            console.error(`### executing failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
        }
    }
}

run();
