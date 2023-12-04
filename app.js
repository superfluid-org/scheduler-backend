const fs = require("fs");
const { ethers } = require("ethers");
const sfMeta = require("@superfluid-finance/metadata")
const VestingSchedulerAbi = require("./VestingSchedulerAbi.json");


const privKey = process.env.PRIVKEY;
if (!privKey) throw "missing PRIVKEY env var";

const rpcUrl = process.env.RPC;
if (!rpcUrl) throw "missing RPC env var";

const vSchedAddrOverride = process.env.VSCHED_ADDR; // default: get from metadata

// where to start when no state is persisted. Defaults to protocol deployment block 
// which can be long before scheduler contract deployment, thus take unnecessarily long to bootstrap.
const initStartBlockOverride = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined;
// eth-goerli: 8507393, polygon-mumbai: 33383487, optimism-mainnet: 67820482, polygon-mainnet: 38148531, eth-mainnet: 16418958

// margin to end block in order to avoid reorgs (which aren't handled)
// caution: this can cause state mismatch if the next run occurs before the chain advances by <offset> blocks
const endBlockOffset = process.env.END_BLOCK_OFFSET ? parseInt(process.env.END_BLOCK_OFFSET) : 30;


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

    const vSchedAddr = vSchedAddrOverride || network.contractsV1.vestingScheduler;
    if (!vSchedAddr) throw `no VestingScheduler address provided or found in metadata for network ${network.name}`;
    const vSched = new ethers.Contract(vSchedAddr, VestingSchedulerAbi, provider);

    // relevant only when starting from scratch, without persisted state
    let startBlock = initStartBlockOverride || network.startBlockV1;
    let activeSchedules = [];
    let removedSchedules = [];

    // load persisted state
    const stateFileName = `state_${network.name}.json`;
    if (fs.existsSync(stateFileName)) {
        const state = JSON.parse(fs.readFileSync(stateFileName));
        console.log(`init: loaded state from file - startBlock: ${state.lastBlock}, activeSchedules: ${state.activeSchedules.length}, removedSchedules: ${state.removedSchedules.length}`);
        startBlock = state.lastBlock;
        activeSchedules = state.activeSchedules;
        removedSchedules = state.removedSchedules;
    } else {
        console.log(`!!! init: no state file ${stateFileName} found, starting from scratch`);
    }

    console.log(`init: using VestingScheduler contract ${vSchedAddr}`);

    // =====================================
    // sync local state with contract state
    // =====================================

    async function getEventsInRange(event, start, end) {
        const filter = event;
        return await vSched.queryFilter(filter, start, end);
    }

    function parseEvent(contract, event) {
        if (event.removed) throw "### removed flag true - handling for this is not implemented";

        const eventSignature = event.topics[0];
        const eventFragment = contract.interface.getEvent(eventSignature);
        const eventName = eventFragment.name;

        const parsedLog = contract.interface.parseLog(event);

        //console.log(`keys: ${JSON.stringify(Object.keys(parsedLog.args), null, 2)}`);

        return {
            name: eventName,
            // mandatory in all events
            superToken: parsedLog.args.superToken,
            sender: parsedLog.args.sender,
            receiver: parsedLog.args.receiver,
            // in some events
            startDate: parsedLog.args.startDate ? parseInt(parsedLog.args.startDate) : undefined,
            cliffDate: parsedLog.args.cliffDate ? parseInt(parsedLog.args.cliffDate) : undefined,
            //flowRate: parsedLog.args.flowRate.toString(),
            endDate: parsedLog.args.endDate ? parseInt(parsedLog.args.endDate) : undefined,
            //cliffAmount: parsedLog.args.cliffAmount.toString(),
            // metadata
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
        };
    }

    const endBlock = (await provider.getBlockNumber()) - endBlockOffset;
    if (endBlock < startBlock) throw `endBlock ${endBlock} < startBlock ${startBlock}`;
    console.log(`*** query for past events from ${startBlock} to ${endBlock} (delta: ${endBlock - startBlock}) with log range ${network.logsQueryRange} ...`);
    
    function getIndexOf(superToken, sender, receiver) {
        return activeSchedules.findIndex(v => v.superToken === superToken && v.sender === sender && v.receiver === receiver);
    }

    // classic iteration over range queries for logs, usually done in a few mins with a "close" RPC
    for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += network.logsQueryRange) {
        const toBlock = Math.min(fromBlock + network.logsQueryRange - 1, endBlock);

        const topicFilter = [
            (await vSched.filters.VestingScheduleCreated().getTopicFilter())
            .concat(await vSched.filters.VestingScheduleUpdated().getTopicFilter())
            .concat(await vSched.filters.VestingScheduleDeleted().getTopicFilter())
            .concat(await vSched.filters.VestingCliffAndFlowExecuted().getTopicFilter())
            .concat(await vSched.filters.VestingEndExecuted().getTopicFilter())
            .concat(await vSched.filters.VestingEndFailed().getTopicFilter())
        ];

        const newEvents = await getEventsInRange(topicFilter, fromBlock, toBlock);
        console.log(`*** query for past events from ${fromBlock} to ${toBlock} (of ${endBlock}) returned ${newEvents.length} events`);
        
        const eventHandlerFunctions = {
            handleVestingScheduleCreated: function(e) {
                //console.log(`created event ${JSON.stringify(e, null, 2)}`);
                //const parsedEvent = vSched.interface.parseLog(e);
                const parsedEvent = parseEvent(vSched, e);

                console.log(`CREATED ${JSON.stringify(parsedEvent, null, 2)}`);
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex >= 0) throw `trying to add pre-existing schedule for ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;

                // we define our own custom data structure for vesting schedules, containing just what we need
                activeSchedules.push({
                    // the first 3 together identify a schedule
                    superToken: parsedEvent.superToken,
                    sender: parsedEvent.sender,
                    receiver: parsedEvent.receiver,
                    // start & end date tell us when to act
                    startDate /*cliffAndFlowDate in contract*/: parsedEvent.cliffDate == 0 ? parsedEvent.startDate : parsedEvent.cliffDate,
                    endDate: parsedEvent.endDate,
                    // the rest we don't really need, but remember anyway
                    flowRate: parsedEvent.flowRate,
                    cliffAmount: parsedEvent.cliffAmount,
                    createdTxHash: parsedEvent.transactionHash,
                    // our meta state, to be updated by consecutive events
                    started: false,
                    stopped: false,
                    failed: false
                });
            },

            handleVestingScheduleUpdated: function(e) {
                const parsedEvent = parseEvent(vSched, e);
                // assert that the schedule exists
                // update it
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex == -1) throw `trying to update schedule which doesn't exist: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;
                const prevEndDate = activeSchedules[curIndex].endDate;
                //assertion
                if (prevEndDate != parsedEvent.endDate) throw `mismatch of old endDate for ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver} | persisted ${prevEndDate}, in vent ${parsedEvent.endDate}`;

                activeSchedules[curIndex].endDate = parsedEvent.endDate;
                console.log(`UPDATED: endDate ${parsedEvent.endDate} for ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`);
            },

            handleVestingScheduleDeleted: function(e) {
                const parsedEvent = parseEvent(vSched, e);
                console.log(`DELETED: ${JSON.stringify(parsedEvent, null, 2)}`);
                // assert that the schedule exists
                // delete it
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex == -1) throw `trying to delete schedule which doesn't exist: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;
                removedSchedules.push(activeSchedules[curIndex]);
                activeSchedules.splice(curIndex, 1);
            },

            handleVestingCliffAndFlowExecuted: function(e) {
                const parsedEvent = parseEvent(vSched, e);
                //console.log(`started raw ${JSON.stringify(e, null, 2)}`);
                //console.log(`started parsed ${JSON.stringify(parsedEvent, null, 2)}`);
                console.log(`STARTED: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`);
                // assert that the schedule exists
                // update it
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex == -1) throw `trying to start schedule which doesn't exist: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;
                
                activeSchedules[curIndex].started = true;
            },

            handleVestingEndExecuted: function(e) {
                const parsedEvent = parseEvent(vSched, e);
                console.log(`STOPPED: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`);
                // assert that the schedule exists
                // update it
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex == -1) throw `trying to stop schedule which doesn't exist: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;
                
                activeSchedules[curIndex].stopped = true;
                removedSchedules.push(activeSchedules[curIndex]);
                activeSchedules.splice(curIndex, 1);
            },

            handleVestingEndFailed: function(e) {
                const parsedEvent = parseEvent(vSched, e);
                console.log(`FAILED: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`);
                // assert that the schedule exists
                // update it
                const curIndex = getIndexOf(parsedEvent.superToken, parsedEvent.sender, parsedEvent.receiver);
                if (curIndex == -1) throw `trying to stop schedule which doesn't exist: ${parsedEvent.superToken} ${parsedEvent.sender} ${parsedEvent.receiver}`;
                
                activeSchedules[curIndex].failed = true;
                removedSchedules.push(activeSchedules[curIndex]);
                activeSchedules.splice(curIndex, 1);
            }
        };

        newEvents.forEach(e => {
            //console.log(`new event ${JSON.stringify(e, null, 2)}`);
            //const parsedEvent = vSched.interface.parseLog(e);
            const parsedEvent = parseEvent(vSched, e);
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
    const startDateValidAfter = parseInt(await vSched.START_DATE_VALID_AFTER());
    const endDateValidBefore = parseInt(await vSched.END_DATE_VALID_BEFORE());
    console.log(`*** blockTime: ${blockTime}, startDateValidAfter: ${startDateValidAfter}, endDateValidBefore: ${endDateValidBefore}`);
    
    const toBeStarted = activeSchedules.filter(s => !s.started && s.startDate <= blockTime);
    console.log(`${toBeStarted.length} of ${activeSchedules.length} schedules to be started`);

    const toBeStopped = activeSchedules.filter(s => !s.stopped && s.endDate - endDateValidBefore <= blockTime);
    console.log(`${toBeStopped.length} of ${activeSchedules.length} schedules to be stopped`);

    for (let i = 0; i < toBeStarted.length; i++) {
        const s = toBeStarted[i];
        console.log(`processing{start} ${JSON.stringify(s, null, 2)}`);

        const dueSinceS = blockTime - s.startDate;
        console.log(`dueSinceS: ${dueSinceS}`);
        if (dueSinceS > startDateValidAfter) {
            console.warn(`### start time window missed for ${s.superToken} ${s.sender} ${s.receiver} by ${dueSinceS - startDateValidAfter} s, skipping`);
            continue;
            // TODO: could be removed from state once we're sure about it
        }

        // sanity check
        const curState = await vSched.getVestingSchedule(s.superToken, s.sender, s.receiver);
        if (s.endDate != parseInt(curState.endDate)) throw `state mismatch for ${s.superToken} ${s.sender} ${s.receiver} | contract endDate: ${curState.endDate.toString()}, persisted endDate ${curState.endDate}`;
        
        try {
            console.log(`+++ starting: ${s.superToken} ${s.sender} ${s.receiver} - ${dueSinceS} s overdue | cliffAndFlowDate: ${curState.cliffAndFlowDate.toString()}, endDate ${curState.endDate}, flowRate ${curState.flowRate}, cliffAmount ${curState.cliffAmount}`);
            const tx = await vSched.connect(signer).executeCliffAndFlow(s.superToken, s.sender, s.receiver);
            console.log(`+++ waiting for tx ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`+++ receipt: ${receipt}`);
            // we don't change the local state, but rely on resulting events parsed when running next
        } catch(e) {
            console.error(`### starting failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
        }
    }

    for (let i = 0; i < toBeStopped.length; i++) {
        const s = toBeStopped[i];
        console.log(`processing{stop} ${JSON.stringify(s, null, 2)}`);

        // sanity check
        const curState = await vSched.getVestingSchedule(s.superToken, s.sender, s.receiver);
        if (s.endDate != parseInt(curState.endDate)) throw `state mismatch for ${s.superToken} ${s.sender} ${s.receiver} | contract endDate: ${curState.endDate.toString()}, persisted endDate ${curState.endDate}`;

        const stoppableSince = s.endDate - endDateValidBefore;
        if (blockTime > s.endDate) {
            console.warn(`!!! stopping overdue, end time missed for ${s.superToken} ${s.sender} ${s.receiver} by ${blockTime - s.endDate} s !!!`);
        }
        try {
            console.log(`+++ stopping: ${s.superToken} ${s.sender} ${s.receiver} - s.endDate ${curState.endDate}, flowRate ${curState.flowRate}`);
            const tx = await vSched.connect(signer).executeEndVesting(s.superToken, s.sender, s.receiver);
            console.log(`+++ waiting for tx ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`+++ receipt: ${JSON.stringify(receipt, null, 2)}`);
            // we don't change the local state, but rely on resulting events parsed when running next
        } catch(e) {
            console.error(`### stopping failed for ${s.superToken} ${s.sender} ${s.receiver}: ${e}`);
        }
    }
}

run();

// example for how to analyze the state file:
// cat state_polygon-mumbai.json | jq '.schedules[] | select(.started == false)'
