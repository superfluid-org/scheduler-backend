const fs = require("fs");
const { ethers } = require("ethers");
const sfMeta = require("@superfluid-finance/metadata")
const FlowSchedulerAbi = require("./FlowSchedulerAbi.json");

const privKey = process.env.PRIVKEY;
if (!privKey) throw "missing PRIVKEY env var";

const rpcUrl = process.env.RPC;
if (!rpcUrl) throw "missing RPC env var";

const fSchedAddrOverride = process.env.FSCHED_ADDR; // default: get from metadata

// where to start when no state is persisted. Defaults to protocol deployment block
// which can be long before scheduler contract deployment, thus take unnecessarily long to bootstrap.
const initStartBlockOverride = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined;
// eth-goerli: 8507393, polygon-mumbai: 33383487, optimism-mainnet: 67820482, polygon-mainnet: 38148531,
// eth-mainnet: 16418958, avalanche-c: 25012325, bsc-mainnet: 24833789, xdai-mainnet: 25992375, arbitrum-one: 53448990

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
    console.log(`init: connected to network via RPC ${rpcUrl} with chainId ${chainId}`);

    const network = sfMeta.getNetworkByChainId(chainId);
    if (!network) throw `no network found for chainId ${chainId}`;
    console.log(`init: network ${network.name}`);

    const wallet = new ethers.Wallet(privKey);
    const signer = wallet.connect(provider);

    console.log(`init: signer account: ${signer.address}`);

    const fSchedAddr = fSchedAddrOverride || network.contractsV1.flowScheduler;
    if (!fSchedAddr) throw `no FlowScheduler address provided or found in metadata for network ${network.name}`;
    const fSched = new ethers.Contract(fSchedAddr, FlowSchedulerAbi, provider);

    // relevant only when starting from scratch, without persisted state
    let startBlock = initStartBlockOverride || network.startBlockV1;
    let activeSchedules = [];
    let removedSchedules = [];

    // load persisted state
    const stateFileName = `data/flowschedules_${network.name}.json`;
    if (fs.existsSync(stateFileName)) {
        const state = JSON.parse(fs.readFileSync(stateFileName));
        console.log(`init: loaded state from file - startBlock: ${state.lastBlock}, activeSchedules: ${state.activeSchedules.length}, removedSchedules: ${state.removedSchedules.length}`);
        startBlock = state.lastBlock;
        activeSchedules = state.activeSchedules;
        removedSchedules = state.removedSchedules;
    } else {
        console.log(`!!! init: no state file ${stateFileName} found, starting from scratch`);
    }

    console.log(`init: using FlowScheduler contract ${fSchedAddr}`);

    // =====================================
    // sync local state with contract state
    // =====================================

    async function getEventsInRange(event, start, end) {
        const filter = event;
        return await fSched.queryFilter(filter, start, end);
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

    const endBlock = (await provider.getBlockNumber()) - endBlockOffset;
    const logsQueryRange = logsQueryRangeOverride || network.logsQueryRange;
    if (endBlock < startBlock) throw `endBlock ${endBlock} < startBlock ${startBlock}`;
    console.log(`*** query for past events from ${startBlock} to ${endBlock} (delta: ${endBlock - startBlock}) with logs query range ${logsQueryRange} ...`);

    function getIndexOf(superToken, sender, receiver) {
        return activeSchedules.findIndex(v => v.superToken === superToken && v.sender === sender && v.receiver === receiver);
    }

    // classic iteration over range queries for logs, usually done in a few mins with a "close" RPC
    for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += logsQueryRange) {
        const toBlock = Math.min(fromBlock + logsQueryRange - 1, endBlock);

        const topicFilter = [
            (await fSched.filters.FlowScheduleCreated().getTopicFilter())
            .concat(await fSched.filters.FlowScheduleDeleted().getTopicFilter())
            .concat(await fSched.filters.CreateFlowExecuted().getTopicFilter())
            .concat(await fSched.filters.DeleteFlowExecuted().getTopicFilter())
        ];

        const newEvents = await getEventsInRange(topicFilter, fromBlock, toBlock);
        console.log(`*** query for past events from ${fromBlock} to ${toBlock} (of ${endBlock}) returned ${newEvents.length} events`);

        const eventHandlerFunctions = {
            handleFlowScheduleCreated: function(e) {
                console.log(`created event ${JSON.stringify(e, null, 2)}`);
                //const parsedEvent = fSched.interface.parseLog(e);
                const parsedEvent = parseEvent(fSched, e);

                console.log(`CREATED ${JSON.stringify(parsedEvent, null, 2)}`);
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex >= 0) throw `trying to add pre-existing schedule for ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;

                // we define our own custom data structure for flow schedules, containing just what we need
                activeSchedules.push({
                    // the first 3 together identify a schedule
                    superToken: parsedEvent.superToken,
                    sender: parsedEvent.sender,
                    receiver: parsedEvent.receiver,
                    // start & end date tell us when to act
                    startDate: parsedEvent.startDate,
                    endDate: parsedEvent.endDate,
                    // userData needs to be provided in the exec txs
                    userData: parsedEvent.userData,
                    // our meta state, to be updated by consecutive events
                    started: false,
                    stopped: false,
                    failed: false
                });
            },

            handleFlowScheduleDeleted: function(e) {
                const parsedEvent = parseEvent(fSched, e);
                console.log(`DELETED: ${JSON.stringify(parsedEvent, null, 2)}`);
                // assert that the schedule exists
                // delete it
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex == -1) throw `trying to delete schedule which doesn't exist: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;
                removedSchedules.push(activeSchedules[curIndex]);
                activeSchedules.splice(curIndex, 1);
            },

            handleCreateFlowExecuted: function(e) {
                const parsedEvent = parseEvent(fSched, e);
                //console.log(`started raw ${JSON.stringify(e, null, 2)}`);
                //console.log(`started parsed ${JSON.stringify(parsedEvent, null, 2)}`);
                console.log(`STARTED: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`);
                // assert that the schedule exists
                // update it
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex == -1) throw `trying to start schedule which doesn't exist: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;

                activeSchedules[curIndex].started = true;
            },

            handleDeleteFlowExecuted: function(e) {
                const parsedEvent = parseEvent(fSched, e);
                console.log(`STOPPED: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`);
                // assert that the schedule exists
                // update it
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex == -1) throw `trying to stop schedule which doesn't exist: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;

                activeSchedules[curIndex].stopped = true;
                removedSchedules.push(activeSchedules[curIndex]);
                activeSchedules.splice(curIndex, 1);
            }
        };

        newEvents.forEach(e => {
            console.log(`new event ${JSON.stringify(e, null, 2)}`);
            //const parsedEvent = fSched.interface.parseLog(e);
            const parsedEvent = parseEvent(fSched, e);
            //console.log(`parsed event ${JSON.stringify(parsedEvent, null, 2)}`);
            eventHandlerFunctions[`handle${parsedEvent.name}`](e);
        });

        console.log(`*** have ${activeSchedules.length} schedules, ${removedSchedules.length} removed schedules`);

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

    const toBeStarted = activeSchedules.filter(s => !s.started && s.startDate + executionDelayS <= blockTime);
    console.log(`${toBeStarted.length} of ${activeSchedules.length} schedules to be started`);

    const toBeStopped = activeSchedules.filter(s => !s.stopped && s.endDate + executionDelayS <= blockTime);
    console.log(`${toBeStopped.length} of ${activeSchedules.length} schedules to be stopped`);

    for (let i = 0; i < toBeStarted.length; i++) {
        const s = toBeStarted[i];
        console.log(`processing{start} ${JSON.stringify(s, null, 2)}`);

        const dueSinceS = blockTime - s.startDate;
        console.log(`dueSinceS: ${dueSinceS}`);
        if (dueSinceS > s.startMaxDelay) {
            console.warn(`### start time window missed for ${s.superToken} ${s.sender} ${s.receiver} by ${dueSinceS - s.startMaxDelay} s, skipping`);
            continue;
            // TODO: could be removed from state once we're sure about it
        }

        // sanity check
        const curState = await fSched.getFlowSchedule(s.superToken, s.sender, s.receiver);
        if (s.endDate != parseInt(curState.endDate)) throw `state mismatch for ${s.superToken} ${s.sender} ${s.receiver} | contract endDate: ${curState.endDate.toString()}, persisted endDate ${curState.endDate}`;

        try {
            console.log(`+++ starting: ${s.superToken} ${s.sender} ${s.receiver} - ${dueSinceS} s overdue | startDate: ${curState.startDate.toString()}, endDate ${curState.endDate}, flowRate ${curState.flowRate}, startAmount ${curState.startAmount}`);
            const estGasLimit = await fSched.estimateGas.executeCreateFlow(s.superToken, s.sender, s.receiver, curState.userData, { from: signer.address });
            const gasLimit = estGasLimit.mul(140).div(100); // increase by 40%
            const tx = await fSched.connect(signer).executeCreateFlow(s.superToken, s.sender, s.receiver, curState.userData, { gasLimit });
            console.log(`+++ waiting for tx ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
            // we don't change the local state, but rely on resulting events parsed when running next
        } catch(e) {
            console.error(`### starting failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
        }
    }

    for (let i = 0; i < toBeStopped.length; i++) {
        const s = toBeStopped[i];
        console.log(`processing{stop} ${JSON.stringify(s, null, 2)}`);

        // sanity check
        const curState = await fSched.getFlowSchedule(s.superToken, s.sender, s.receiver);
        if (s.endDate != parseInt(curState.endDate)) throw `state mismatch for ${s.superToken} ${s.sender} ${s.receiver} | contract endDate: ${curState.endDate.toString()}, persisted endDate ${curState.endDate}`;

        try {
            console.log(`+++ stopping: ${s.superToken} ${s.sender} ${s.receiver} - s.endDate ${curState.endDate}, flowRate ${curState.flowRate}`);
            const estGasLimit = await fSched.estimateGas.executeDeleteFlow(s.superToken, s.sender, s.receiver, curState.userData, { from: signer.address });
            const gasLimit = estGasLimit.mul(140).div(100); // increase by 40%
            const tx = await fSched.connect(signer).executeDeleteFlow(s.superToken, s.sender, s.receiver, curState.userData, { gasLimit });
            console.log(`+++ waiting for tx ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`+++ receipt: ${JSON.stringify(receipt)}`);
            // we don't change the local state, but rely on resulting events parsed when running next
        } catch(e) {
            console.error(`### stopping failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
        }
    }
}

run();
