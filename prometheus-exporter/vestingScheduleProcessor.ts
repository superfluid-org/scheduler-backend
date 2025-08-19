import axios, { AxiosResponse } from 'axios';
import chalk from 'chalk';
import { ProcessorBase, formatDuration } from './processorBase';

const END_DATE_VALID_BEFORE = 24 * 60 * 60; // 1 day in seconds

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
    status: 'not_started' | 'active' | 'ended' | 'failed';
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
        const isClaimable = schedule.claimValidityDate > 0;
        const isClaimed = schedule.claimedAt !== null;
        const isStarted = schedule.cliffAndFlowExecutedAt !== null;
        const isEnded = schedule.endExecutedAt !== null;
        const isFailed = schedule.failedAt !== null;
        const isDeleted = schedule.deletedAt !== null;

        let status: 'not_started' | 'active' | 'ended' | 'failed';
        if (isDeleted) {
            // If a schedule is deleted, it's considered ended
            status = 'ended';
        } else if (isFailed) {
            status = 'failed';
        } else if (isEnded) {
            status = 'ended';
        } else if (isStarted) {
            status = 'active';
        } else {
            status = 'not_started';
        }

        const isInStopWindow = status === 'active' && 
            schedule.endDate > 0 && 
            now >= (schedule.endDate - END_DATE_VALID_BEFORE) && 
            !isEnded &&
            !isDeleted;

        return {
            schedule,
            status,
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
        const now = Math.floor(Date.now() / 1000);

        // Categorize schedules
        const notStarted = schedules.filter(s => s.status === 'not_started');
        const active = schedules.filter(s => s.status === 'active');
        const ended = schedules.filter(s => s.status === 'ended');
        const failed = schedules.filter(s => s.status === 'failed');

        // Sort active schedules by time until end (descending)
        active.sort((a, b) => {
            const timeUntilEndA = a.schedule.endDate - now;
            const timeUntilEndB = b.schedule.endDate - now;
            return timeUntilEndB - timeUntilEndA;
        });

        // Print active schedules (always)
        console.log('\nActive Schedules:');
        console.log('----------------');
        active.forEach(s => {
            const runningTime = now - (s.schedule.cliffAndFlowExecutedAt || 0);
            const timeUntilEnd = s.schedule.endDate - now;
            
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
        });

        if (verbose || printFinished) {
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

        if (verbose) {
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
                if (s.isClaimable) {
                    console.log(`Claimable until: ${new Date(s.schedule.claimValidityDate * 1000).toISOString()}`);
                    console.log(`Status: ${s.isClaimed ? 'Claimed' : 'Not claimed'}`);
                } else {
                    console.log(`Start date: ${new Date(s.schedule.startDate * 1000).toISOString()}`);
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
        }

        // Print summary
        console.log('\nSummary:');
        console.log(`Total Schedules: ${schedules.length}`);
        console.log(`Not Started: ${notStarted.length}`);
        console.log(`Active: ${active.length}`);
        console.log(`Ended: ${ended.length}`);
        console.log(`Failed: ${failed.length}`);

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