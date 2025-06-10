import axios, { AxiosResponse } from 'axios';

const MAX_ITEMS = 1000;
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

/**
 * Formats a duration in seconds into a human-readable string
 */
function formatDuration(seconds: number): string {
    if (seconds < 0) {
        return `${formatDuration(-seconds)} ago`;
    }

    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((seconds % (60 * 60)) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(' ') || 'less than a minute';
}

class VestingScheduleProcessor {
    private readonly subgraphUrl: string;

    constructor(subgraphUrl: string) {
        this.subgraphUrl = subgraphUrl;
    }

    /**
     * Queries all pages of a paginated GraphQL response.
     */
    private async _queryAllPages(queryFn: (lastId: string) => string, toItems: (res: AxiosResponse<any>) => any[], itemFn: (item: any) => any): Promise<any[]> {
        let lastId = "";
        const items: any[] = [];

        while (true) {
            const res = await this._graphql(queryFn(lastId));

            if (res.status !== 200 || res.data.errors) {
                console.error(`bad response ${res.status}`);
                throw new Error(`GraphQL query failed: ${res.data.errors}`);
            } else if (res.data === "") {
                console.error("empty response data");
                throw new Error("Empty response data from GraphQL query");
            } else {
                const newItems = toItems(res);
                items.push(...newItems.map(itemFn));

                if (newItems.length < MAX_ITEMS) {
                    break;
                } else {
                    lastId = newItems[newItems.length - 1].id;
                }
            }
        }

        return items;
    }

    private async _graphql(query: string): Promise<AxiosResponse> {
        return axios.post(this.subgraphUrl, { query });
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
    public async processSchedules(): Promise<ProcessedSchedule[]> {
        const queryFn = (lastId: string) => `
            {
                vestingSchedules(
                    first: ${MAX_ITEMS},
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
                    events(skip: 0, first: 100, orderBy: id, orderDirection: asc) {
                        id
                        blockNumber
                        logIndex
                        order
                        name
                        addresses
                        timestamp
                        transactionHash
                        gasPrice
                    }
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

async function main() {
    const subgraphUrl = process.env.SUBGRAPH_URL || process.argv[2];
    if (!subgraphUrl) {
        console.error('Please provide a subgraph URL either as SUBGRAPH_URL environment variable or as command line argument');
        process.exit(1);
    }

    const printFinished = process.env.PRINT_FINISHED === 'true';
    const verbose = process.env.VERBOSE === 'true';

    try {
        const processor = new VestingScheduleProcessor(subgraphUrl);
        const schedules = await processor.processSchedules();
        const now = Math.floor(Date.now() / 1000);

        // Categorize schedules
        const notStarted = schedules.filter(s => s.status === 'not_started');
        const active = schedules.filter(s => s.status === 'active');
        const ended = schedules.filter(s => s.status === 'ended');
        const failed = schedules.filter(s => s.status === 'failed');

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
                console.log(`(Can be stopped now)`);
            } else {
                const timeUntilStopWindow = (s.schedule.endDate - END_DATE_VALID_BEFORE) - now;
                console.log(`(Can be stopped in: ${formatDuration(timeUntilStopWindow)})`);
            }
            console.log('----------------');
        });

        if (verbose || printFinished) {
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
        console.error('Error processing schedules:', error);
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