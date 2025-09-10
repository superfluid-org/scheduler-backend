import axios, { AxiosResponse } from 'axios';
import chalk from 'chalk';
import { ProcessorBase, formatDuration } from './processorBase';

const END_DATE_VALID_BEFORE = 24 * 60 * 60; // 1 day in seconds
const START_DATE_VALID_AFTER = 3 * 24 * 60 * 60; // 3 days in seconds

interface VestingScheduleEvent {
    id: string;
    blockNumber: number;
    logIndex: number;
    order: number;
    name: string;
    addresses: string[];
    timestamp: number;
    transactionHash: string;
    gasPrice: string;
}

interface VestingSchedule {
    id: string;
    contractVersion: number;
    createdAt: number;
    superToken: string;
    sender: string;
    receiver: string;
    startDate: number;
    endDate: number;
    cliffDate: number;
    cliffAndFlowDate: number;
    cliffAmount: string;
    flowRate: string;
    didEarlyEndCompensationFail: boolean;
    earlyEndCompensation: string;
    cliffAndFlowExpirationAt: number;
    endDateValidAt: number;
    deletedAt: number | null;
    failedAt: number | null;
    cliffAndFlowExecutedAt: number | null;
    endExecutedAt: number | null;
    events: VestingScheduleEvent[];
    claimValidityDate: number;
    claimedAt: number | null;
    remainderAmount: string;
}

interface ProcessedSchedule {
    schedule: VestingSchedule;
    status: 'not_started' | 'active' | 'ended' | 'failed' | 'claimable';
    isInStartWindow: boolean;
    isInStopWindow: boolean;
    isClaimable: boolean;
    isClaimed: boolean;
}

class VestingScheduleProcessor extends ProcessorBase {
    constructor(subgraphUrl: string, networkName: string) {
        super(subgraphUrl, networkName);
    }

    /**
     * Determines the status of a schedule
     */
    private getScheduleStatus(schedule: VestingSchedule): ProcessedSchedule {
        const now = Math.floor(Date.now() / 1000);
        const isClaimable = Number(schedule.claimValidityDate) > 0;
        const isClaimed = schedule.claimedAt !== null;
        const isStarted = schedule.cliffAndFlowExecutedAt !== null;
        const isEnded = schedule.endExecutedAt !== null;
        const isFailed = schedule.failedAt !== null;
        const isDeleted = schedule.deletedAt !== null;

        let status: 'not_started' | 'active' | 'ended' | 'failed' | 'claimable';
        if (isDeleted) {
            // If a schedule is deleted, it's considered ended
            status = 'ended';
        } else if (isFailed) {
            status = 'failed';
        } else if (isEnded) {
            status = 'ended';
        } else if (isStarted) {
            status = 'active';
        } else if (isClaimable) {
            status = 'claimable';
        } else {
            status = 'not_started';
        }

        const claimValidityDate = Number(schedule.claimValidityDate);
        const cliffAndFlowDate = Number(schedule.cliffAndFlowDate);
        
        const isInStartWindow = status === 'not_started' &&
            cliffAndFlowDate > 0 && // Schedule exists and hasn't been executed
            now >= cliffAndFlowDate && // Cliff/flow date has passed
            now <= (claimValidityDate > 0 ? claimValidityDate : cliffAndFlowDate + START_DATE_VALID_AFTER); // Within execution window

        const isInStopWindow = status === 'active' && 
            schedule.endDate > 0 && 
            now >= (schedule.endDate - END_DATE_VALID_BEFORE) && 
            !isEnded &&
            !isDeleted;

        return {
            schedule,
            status,
            isInStartWindow,
            isInStopWindow,
            isClaimable,
            isClaimed
        };
    }

    /**
     * Processes all vesting schedules and returns them with their status
     */
    public async getVestingSchedules(): Promise<ProcessedSchedule[]> {
        const queryFn = (lastId: string) => `
            {
                vestingSchedules(
                    first: ${this.MAX_ITEMS},
                    where: { id_gt: "${lastId}" },
                    orderBy: id,
                    orderDirection: asc
                ) {
                    id
                    contractVersion
                    createdAt
                    superToken
                    sender
                    receiver
                    startDate
                    endDate
                    cliffDate
                    cliffAndFlowDate
                    cliffAmount
                    flowRate
                    didEarlyEndCompensationFail
                    earlyEndCompensation
                    cliffAndFlowExpirationAt
                    endDateValidAt
                    deletedAt
                    failedAt
                    cliffAndFlowExecutedAt
                    endExecutedAt
                    claimValidityDate
                    claimedAt
                    remainderAmount
                }
            }
        `;

        const toItems = (res: AxiosResponse) => res.data.data.vestingSchedules;
        const itemFn = (schedule: VestingSchedule) => this.getScheduleStatus(schedule);

        return this._queryAllPages(queryFn, toItems, itemFn);
    }
}

// used only for interactive debugging
async function main() {
    const subgraphUrl = process.env.SUBGRAPH_URL || process.argv[2];
    if (!subgraphUrl) {
        console.error('Please provide a subgraph URL either as SUBGRAPH_URL environment variable or as command line argument');
        process.exit(1);
    }

    const printFinished = process.env.PRINT_FINISHED === 'true';
    const verbose = process.env.VERBOSE === 'true';

    try {
        const processor = new VestingScheduleProcessor(subgraphUrl, 'unknown');
        const schedules = await processor.getVestingSchedules();
        console.log(`Found ${schedules.length} schedules`);
        const now = Math.floor(Date.now() / 1000);

        // Categorize schedules
        const notStarted = schedules.filter(s => s.status === 'not_started');
        const started = schedules.filter(s => s.status === 'active');
        const ended = schedules.filter(s => s.status === 'ended');
        const failed = schedules.filter(s => s.status === 'failed');
        const claimable = schedules.filter(s => s.isClaimable);
        
        // Additional categorization for hierarchical summary
        const autoStartSchedules = notStarted.filter(s => !s.isClaimable);
        const claimableSchedules = claimable.filter(s => s.status === 'claimable');
        const flowingSchedules = started;
        const schedulesInStartWindow = notStarted.filter(s => s.isInStartWindow);
        const schedulesInStopWindow = started.filter(s => s.isInStopWindow);

        if (verbose) {
            // Verbose mode: show all schedules
            console.log(`Found ${ended.length} ended schedules`);
            console.log(`Found ${failed.length} failed schedules`);
            console.log(`Found ${notStarted.length} not started schedules`);
            console.log(`Found ${started.length} started schedules`);

            // Sort not started schedules by start date (soonest first)
            notStarted.sort((a, b) => a.schedule.startDate - b.schedule.startDate);

            // Print not started schedules
            console.log('\nNot Started Schedules:');
            console.log('----------------');
            notStarted.forEach(s => {
                console.log(`ID: ${s.schedule.id}`);
                console.log(`SuperToken: ${s.schedule.superToken}`);
                console.log(`Sender: ${s.schedule.sender}`);
                console.log(`Receiver: ${s.schedule.receiver}`);
                console.log(`Start date: ${new Date(s.schedule.startDate * 1000).toISOString()}`);
                if (s.isClaimable) {
                    console.log(`Claimable until: ${new Date(Number(s.schedule.claimValidityDate) * 1000).toISOString()}`);
                    console.log(`Status: ${s.isClaimed ? 'Claimed' : 'Not claimed'}`);
                } else {
                    if (s.isInStartWindow) {
                        console.log(chalk.green.bold('(Can be started now)'));
                    } else {
                        const timeUntilStartWindow = Number(s.schedule.cliffAndFlowDate) - now;
                        console.log(`(Can be started in: ${formatDuration(timeUntilStartWindow)})`);
                    }
                }
                console.log('----------------');
            });

            // Sort failed schedules by failure time (most recent first)
            failed.sort((a, b) => (a.schedule.failedAt || 0) - (b.schedule.failedAt || 0));

            // Print failed schedules
            console.log('\nFailed Schedules:');
            console.log('----------------');
            failed.forEach(s => {
                console.log(`ID: ${s.schedule.id}`);
                console.log(`SuperToken: ${s.schedule.superToken}`);
                console.log(`Sender: ${s.schedule.sender}`);
                console.log(`Receiver: ${s.schedule.receiver}`);
                console.log(`Failed at: ${new Date(s.schedule.failedAt! * 1000).toISOString()}`);
                console.log('----------------');
            });

            // Sort active schedules by time until end (descending)
            started.sort((a, b) => {
                const timeUntilEndA = a.schedule.endDate - now;
                const timeUntilEndB = b.schedule.endDate - now;
                return timeUntilEndB - timeUntilEndA;
            });

            // Print started schedules
            console.log('\nStarted Schedules:');
            console.log('----------------');
            let activeCounter = 0;
            started.forEach(s => {
                const runningTime = now - (s.schedule.cliffAndFlowExecutedAt || 0);
                const timeUntilEnd = s.schedule.endDate - now;
                
                console.log(`#: ${activeCounter}`);
                console.log(`ID: ${s.schedule.id}`);
                console.log(`SuperToken: ${s.schedule.superToken}`);
                console.log(`Sender: ${s.schedule.sender}`);
                console.log(`Receiver: ${s.schedule.receiver}`);
                console.log(`Flow Rate: ${s.schedule.flowRate}`);
                console.log(`Running for: ${formatDuration(runningTime)}`);
                console.log(`Time until end: ${formatDuration(timeUntilEnd)}`);
                if (s.isInStopWindow) {
                    console.log(chalk.yellow.bold('(Can be stopped now)'));
                } else {
                    const timeUntilStopWindow = (s.schedule.endDate - END_DATE_VALID_BEFORE) - now;
                    console.log(`(Can be stopped in: ${formatDuration(timeUntilStopWindow)})`);
                }
                console.log('----------------');
                activeCounter++;
            });

            if (printFinished) {
                // Sort ended schedules by end time (most recent first)
                ended.sort((a, b) => {
                    const endTimeA = a.schedule.deletedAt || a.schedule.endExecutedAt || 0;
                    const endTimeB = b.schedule.deletedAt || b.schedule.endExecutedAt || 0;
                    return endTimeB - endTimeA;
                });

                // Print ended schedules
                console.log('\nEnded Schedules:');
                console.log('----------------');
                ended.forEach(s => {
                    console.log(`ID: ${s.schedule.id}`);
                    console.log(`SuperToken: ${s.schedule.superToken}`);
                    console.log(`Sender: ${s.schedule.sender}`);
                    console.log(`Receiver: ${s.schedule.receiver}`);
                    if (s.schedule.deletedAt) {
                        console.log(`Deleted at: ${new Date(s.schedule.deletedAt * 1000).toISOString()}`);
                    } else if (s.schedule.endExecutedAt) {
                        console.log(`Ended at: ${new Date(s.schedule.endExecutedAt * 1000).toISOString()}`);
                    }
                    console.log('----------------');
                });
            }

        } else {
            // Non-verbose mode: only show schedules in start or stop windows

            console.log(`\nSchedules in Start Window: ${schedulesInStartWindow.length}`);
            console.log('----------------');
            schedulesInStartWindow.forEach(s => {
                const claimValidityDate = Number(s.schedule.claimValidityDate);
                const cliffAndFlowDate = Number(s.schedule.cliffAndFlowDate);
                
                const timeRemainingInStartWindow = claimValidityDate > 0 
                    ? claimValidityDate - now
                    : (cliffAndFlowDate + START_DATE_VALID_AFTER) - now;
                
                console.log(`ID: ${s.schedule.id}`);
                console.log(`SuperToken: ${s.schedule.superToken}`);
                console.log(`Sender: ${s.schedule.sender}`);
                console.log(`Receiver: ${s.schedule.receiver}`);
                console.log(`Start date: ${new Date(s.schedule.startDate * 1000).toISOString()}`);
                if (s.isClaimable) {
                    console.log(`Claimable until: ${new Date(Number(s.schedule.claimValidityDate) * 1000).toISOString()}`);
                    console.log(`Status: ${s.isClaimed ? 'Claimed' : 'Not claimed'}`);
                } else {
                    const timeSinceInStartWindow = now - cliffAndFlowDate;
                    console.log(chalk.green.bold(`(Can be started now - in window for ${formatDuration(timeSinceInStartWindow)}, remaining ${formatDuration(timeRemainingInStartWindow)})`));
                }
                console.log('----------------');
            });

            console.log(`\nSchedules in Stop Window: ${schedulesInStopWindow.length}`);
            console.log('----------------');
            schedulesInStopWindow.forEach(s => {
                const runningTime = now - (s.schedule.cliffAndFlowExecutedAt || 0);
                const timeUntilEnd = s.schedule.endDate - now;
                const timeRemainingInStopWindow = s.schedule.endDate - now; // Time until end date
                
                console.log(`ID: ${s.schedule.id}`);
                console.log(`SuperToken: ${s.schedule.superToken}`);
                console.log(`Sender: ${s.schedule.sender}`);
                console.log(`Receiver: ${s.schedule.receiver}`);
                console.log(`Flow Rate: ${s.schedule.flowRate}`);
                console.log(`Running for: ${formatDuration(runningTime)}`);
                console.log(`Time until end: ${formatDuration(timeUntilEnd)}`);
                const timeSinceInStopWindow = now - (s.schedule.endDate - END_DATE_VALID_BEFORE);
                console.log(chalk.yellow.bold(`(Can be stopped now - in window for ${formatDuration(timeSinceInStopWindow)}, remaining ${formatDuration(timeRemainingInStopWindow)})`));
                console.log('----------------');
            });

        }

        // Print summary (same for both verbose and non-verbose modes)
        console.log('\nSummary:');
        console.log(`Total Schedules: ${schedules.length}`);
        console.log(`  ├─ Pre start: ${notStarted.length + claimableSchedules.length}`);
        console.log(`  │   ├─ Claimable: ${claimableSchedules.length}`);
        console.log(`  │   └─ Auto-start: ${autoStartSchedules.length}`);
        console.log(`  │       └─ In start window: ${schedulesInStartWindow.length}`);
        console.log(`  ├─ Flowing: ${flowingSchedules.length}`);
        console.log(`  │   └─ In stop window: ${schedulesInStopWindow.length}`);
        console.log(`  ├─ Ended: ${ended.length}`);
        console.log(`  └─ Failed: ${failed.length}`);

    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(`Error processing schedules}: ${error.response?.status} ${error.response?.statusText}`);
        } else {
            console.error('Error processing schedules:', error);
        }

        process.exit(1);
    }
}

// Only run if this file is being executed directly
if (require.main === module) {
    main().catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
}

export { VestingScheduleProcessor, VestingSchedule, ProcessedSchedule }; 