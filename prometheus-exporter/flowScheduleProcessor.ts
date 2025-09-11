import axios, { AxiosResponse } from 'axios';
import { ProcessorBase } from './processorBase';
import chalk from 'chalk';
import { formatDuration } from './processorBase';
import { createPublicClient, http } from 'viem';
import { cfaAbi } from "@sfpro/sdk/abi/core";
import sfMeta from '@superfluid-finance/metadata';

interface CreateTask {
    id: string;
    createdAt: number;
    executedAt: number | null;
    executionAt: number;
    expirationAt: number;
    cancelledAt: number | null;
    superToken: string;
    sender: string;
    receiver: string;
    startDate: number;
    startDateMaxDelay: number;
    startAmount: string;
    flowRate: string;
}

interface DeleteTask {
    id: string;
    createdAt: number;
    executedAt: number | null;
    executionAt: number;
    expirationAt: number;
    cancelledAt: number | null;
    superToken: string;
    sender: string;
    receiver: string;
}

interface ProcessedCreateTask {
    task: CreateTask;
    status: 'pending' | 'executed' | 'expired' | 'cancelled';
    isInCreateWindow: boolean;
}

interface ProcessedDeleteTask {
    task: DeleteTask;
    status: 'pending' | 'executed' | 'expired' | 'cancelled' | 'outdated';
    isInDeleteWindow: boolean;
    isNotFlowing: boolean;
}

class FlowScheduleProcessor extends ProcessorBase {
    private readonly rpcUrl: string;

    constructor(subgraphUrl: string, networkName: string, rpcUrl: string) {
        super(subgraphUrl, networkName);
        this.rpcUrl = rpcUrl;
    }

    public async getCreateTasks(): Promise<CreateTask[]> {
        const queryFn = (lastId: string) => `
            {
                createTasks(
                    first: ${this.MAX_ITEMS},
                    where: { id_gt: "${lastId}" },
                    orderBy: id,
                    orderDirection: asc
                ) {
                    id
                    createdAt
                    executedAt
                    executionAt
                    expirationAt
                    cancelledAt
                    superToken
                    sender
                    receiver
                    startDate
                    startDateMaxDelay
                    startAmount
                    flowRate
                }
            }
        `;
        const toItems = (res: AxiosResponse) => res.data.data.createTasks;
        const itemFn = (item: any) => ({
            ...item,
            startDate: Number(item.startDate),
            startDateMaxDelay: Number(item.startDateMaxDelay)
        });
        return this._queryAllPages(queryFn, toItems, itemFn);
    }

    public async getDeleteTasks(): Promise<DeleteTask[]> {
        const queryFn = (lastId: string) => `
            {
                deleteTasks(
                    first: ${this.MAX_ITEMS},
                    where: { id_gt: "${lastId}" },
                    orderBy: id,
                    orderDirection: asc
                ) {
                    id
                    createdAt
                    executedAt
                    executionAt
                    expirationAt
                    cancelledAt
                    superToken
                    sender
                    receiver
                }
            }
        `;
        const toItems = (res: AxiosResponse) => res.data.data.deleteTasks;
        const itemFn = (item: DeleteTask) => item;
        return this._queryAllPages(queryFn, toItems, itemFn);
    }

    /**
     * Determines the status and window state of a create task
     */
    private getCreateTaskStatus(task: CreateTask): ProcessedCreateTask {
        const now = Math.floor(Date.now() / 1000);
        const isExecuted = task.executedAt !== null;
        const isCancelled = task.cancelledAt !== null;
        const isExpired = !isExecuted && !isCancelled && now >= task.expirationAt;

        let status: 'pending' | 'executed' | 'expired' | 'cancelled';
        if (isExecuted) {
            status = 'executed';
        } else if (isCancelled) {
            status = 'cancelled';
        } else if (isExpired) {
            status = 'expired';
        } else {
            status = 'pending';
        }

        // Create window: startDate <= now <= startDate + startDateMaxDelay
        const isInCreateWindow = status === 'pending' &&
            task.startDate > 0 && // Task has a start date
            now >= task.startDate && // Start date has passed
            now <= (task.startDate + task.startDateMaxDelay); // Within max delay window

        return {
            task,
            status,
            isInCreateWindow
        };
    }

    /**
     * Checks flow state between sender and receiver for a delete task
     * Returns object with flow existence and rate information
     */
    private async checkFlowState(task: DeleteTask): Promise<{ hasFlow: boolean; currentFlowRate: bigint }> {
        try {
            const publicClient = createPublicClient({
                transport: http(this.rpcUrl)
            });

            const chainId = await publicClient.getChainId();
            const network = sfMeta.getNetworkByChainId(chainId);
            if (!network) {
                console.warn(`Network not found for chainId ${chainId}, assuming flow exists`);
                return { hasFlow: true, currentFlowRate: 0n }; // Default to true to avoid false negatives
            }

            const cfaAddress = network.contractsV1.cfaV1 as `0x${string}`;
            const superToken = task.superToken as `0x${string}`;
            const sender = task.sender as `0x${string}`;
            const receiver = task.receiver as `0x${string}`;

            // Get the current flow rate between sender and receiver
            const flowData = await publicClient.readContract({
                address: cfaAddress,
                abi: cfaAbi,
                functionName: 'getFlow',
                args: [superToken, sender, receiver]
            }) as [bigint, bigint, bigint, bigint];

            // getFlow returns [flowRate, deposit, owedDeposit, timestamp]
            const currentFlowRate = flowData[0];
            const hasFlow = currentFlowRate > 0n;

            return { hasFlow, currentFlowRate };
        } catch (error) {
            console.warn(`Error checking flow for task ${task.id}:`, error);
            return { hasFlow: true, currentFlowRate: 0n }; // Default to true to avoid false negatives
        }
    }

    /**
     * Determines the status and window state of a delete task
     */
    private async getDeleteTaskStatus(task: DeleteTask): Promise<ProcessedDeleteTask> {
        const now = Math.floor(Date.now() / 1000);
        const isExecuted = task.executedAt !== null;
        const isCancelled = task.cancelledAt !== null;
        const isExpired = !isExecuted && !isCancelled && now >= task.expirationAt;

        let status: 'pending' | 'executed' | 'expired' | 'cancelled' | 'outdated';
        if (isExecuted) {
            status = 'executed';
        } else if (isCancelled) {
            status = 'cancelled';
        } else if (isExpired) {
            status = 'expired';
        } else {
            status = 'pending';
        }

        // Delete window: endDate <= now (no closing time)
        const isInDeleteWindow = status === 'pending' &&
            task.executionAt > 0 && // Task has an execution date
            now >= task.executionAt; // Execution date has passed

        let isNotFlowing = false;

        // Only check flow state for tasks that are in the execution window
        if (isInDeleteWindow) {
            const flowState = await this.checkFlowState(task);
            isNotFlowing = !flowState.hasFlow;
            
            if (isNotFlowing) {
                //console.log(`Delete task ${task.id} - no active flow between ${task.sender} and ${task.receiver}`);
            } else {
                // Log warning if flow rate doesn't match (if we had expected flow rate)
                // For now, just log the current flow rate for debugging
                //console.log(`Delete task ${task.id} - active flow found with rate: ${flowState.currentFlowRate.toString()}`);
            }

            // Business logic: Mark as outdated if in delete window for more than 3 days
            // This is not a contract concept but an execution safety measure to prevent
            // processing flows that may be unrelated to the original schedule. If a delete
            // execution didn't take place and remains lingering and executable forever,
            // it could potentially process flows that were created after the schedule
            // was supposed to be executed, leading to unintended flow deletions.
            const timeInWindow = now - task.executionAt;
            const threeDaysInSeconds = 3 * 24 * 60 * 60; // 3 days
            
            if (timeInWindow > threeDaysInSeconds) {
                status = 'outdated';
                console.log(`Delete task ${task.id} marked as outdated - in window for ${formatDuration(timeInWindow)} (exceeds 3-day safety limit)`);
            }
        }

        return {
            task,
            status,
            isInDeleteWindow,
            isNotFlowing
        };
    }


    /**
     * Gets all create tasks with their processed status
     */
    public async getProcessedCreateTasks(): Promise<ProcessedCreateTask[]> {
        const createTasks = await this.getCreateTasks();
        return createTasks.map(task => this.getCreateTaskStatus(task));
    }

    /**
     * Gets all delete tasks with their processed status
     */
    public async getProcessedDeleteTasks(): Promise<ProcessedDeleteTask[]> {
        const deleteTasks = await this.getDeleteTasks();
        return Promise.all(deleteTasks.map(task => this.getDeleteTaskStatus(task)));
    }

}

async function main() {
    const subgraphUrl = process.env.SUBGRAPH_URL || process.argv[2];
    const rpcUrl = process.env.RPC_URL || process.argv[3];
    
    if (!subgraphUrl) {
        console.error('Please provide a subgraph URL either as SUBGRAPH_URL environment variable or as first command line argument');
        process.exit(1);
    }
    
    if (!rpcUrl) {
        console.error('Please provide an RPC URL either as RPC_URL environment variable or as second command line argument');
        process.exit(1);
    }

    const verbose = process.env.VERBOSE === 'true';

    try {
        const processor = new FlowScheduleProcessor(subgraphUrl, 'unknown', rpcUrl);

        const processedCreates = await processor.getProcessedCreateTasks();
        const processedDeletes = await processor.getProcessedDeleteTasks();

        const now = Math.floor(Date.now() / 1000);

        // Categorize create tasks
        const pendingCreates = processedCreates.filter(t => t.status === 'pending');
        const executedCreates = processedCreates.filter(t => t.status === 'executed');
        const expiredCreates = processedCreates.filter(t => t.status === 'expired');
        const cancelledCreates = processedCreates.filter(t => t.status === 'cancelled');

        // Categorize delete tasks
        const pendingDeletes = processedDeletes.filter(t => t.status === 'pending');
        const executedDeletes = processedDeletes.filter(t => t.status === 'executed');
        const expiredDeletes = processedDeletes.filter(t => t.status === 'expired');
        const cancelledDeletes = processedDeletes.filter(t => t.status === 'cancelled');
        const outdatedDeletes = processedDeletes.filter(t => t.status === 'outdated');
        
        // Sub-categorize pending deletes
        const pendingFlowingDeletes = pendingDeletes.filter(t => !t.isNotFlowing);
        const pendingNotFlowingDeletes = pendingDeletes.filter(t => t.isNotFlowing);

        // Additional categorization for hierarchical summary
        const createsInWindow = pendingCreates.filter(t => t.isInCreateWindow);
        const deletesInWindow = pendingDeletes.filter(t => t.isInDeleteWindow);
        const deletesInWindowFlowing = pendingDeletes.filter(t => t.isInDeleteWindow && !t.isNotFlowing);

        // Helper function to print create task details
        const printCreateTask = (t: ProcessedCreateTask, showAll: boolean = false) => {
            const timeUntilExecution = t.task.startDate - now;
            console.log(`ID: ${t.task.id}`);
            console.log(`SuperToken: ${t.task.superToken}`);
            console.log(`Sender: ${t.task.sender}`);
            console.log(`Receiver: ${t.task.receiver}`);
            console.log(`Flow Rate: ${t.task.flowRate}`);
            console.log(`Start Date: ${new Date(t.task.startDate * 1000).toISOString()} (max delay: ${formatDuration(t.task.startDateMaxDelay)})`);
            
            if (t.isInCreateWindow) {
                const timeSinceInWindow = now - t.task.startDate;
                const timeRemainingInWindow = (t.task.startDate + t.task.startDateMaxDelay) - now;
                console.log(chalk.green.bold(`(Can be executed now - in window for ${formatDuration(timeSinceInWindow)}, remaining ${formatDuration(timeRemainingInWindow)})`));
            } else if (showAll) {
                console.log(`(Can be executed in: ${formatDuration(timeUntilExecution)})`);
            }
            console.log('----------------');
        };

        // Helper function to print delete task details
        const printDeleteTask = (t: ProcessedDeleteTask, showAll: boolean = false) => {
            const timeUntilExecution = t.task.executionAt - now;
            console.log(`ID: ${t.task.id}`);
            console.log(`SuperToken: ${t.task.superToken}`);
            console.log(`Sender: ${t.task.sender}`);
            console.log(`Receiver: ${t.task.receiver}`);
            console.log(`Execution Date: ${new Date(t.task.executionAt * 1000).toISOString()}`);
            
            if (t.status === 'outdated') {
                const timeSinceInWindow = now - t.task.executionAt;
                console.log(chalk.red.bold(`(Outdated - in window for ${formatDuration(timeSinceInWindow)} - exceeds 3-day safety limit)`));
            } else if (t.isInDeleteWindow) {
                const timeSinceInWindow = now - t.task.executionAt;
                if (t.isNotFlowing) {
                    console.log(chalk.red.bold(`(In delete window for ${formatDuration(timeSinceInWindow)} - Not flowing)`));
                } else {
                    console.log(chalk.yellow.bold(`(Can be executed now - in window for ${formatDuration(timeSinceInWindow)})`));
                }
            } else if (showAll) {
                console.log(`(Can be executed in: ${formatDuration(timeUntilExecution)})`);
            }
            console.log('----------------');
        };

        if (verbose) {
            // Verbose mode: show all tasks
            console.log(`Found ${executedCreates.length} executed create tasks`);
            console.log(`Found ${expiredCreates.length} expired create tasks`);
            console.log(`Found ${cancelledCreates.length} cancelled create tasks`);
            console.log(`Found ${pendingCreates.length} pending create tasks`);

            // Sort and print pending creates
            pendingCreates.sort((a, b) => a.task.startDate - b.task.startDate);
            console.log('\nPending Create Tasks:');
            console.log('---------------------');
            pendingCreates.forEach(t => printCreateTask(t, true));

            // Sort and print pending deletes
            pendingDeletes.sort((a, b) => a.task.executionAt - b.task.executionAt);
            console.log('\nPending Delete Tasks:');
            console.log('---------------------');
            pendingDeletes.forEach(t => printDeleteTask(t, true));

            // Print not flowing deletes
            if (pendingNotFlowingDeletes.length > 0) {
                console.log('\nPending Delete Tasks (Not flowing):');
                console.log('-----------------------------------');
                pendingNotFlowingDeletes.forEach(t => printDeleteTask(t, true));
            }

            // Print outdated deletes
            if (outdatedDeletes.length > 0) {
                console.log('\nOutdated Delete Tasks (exceeded 3-day safety limit):');
                console.log('---------------------------------------------------');
                outdatedDeletes.forEach(t => printDeleteTask(t, true));
            }

        } else {
            // Non-verbose mode: only show tasks in execution windows
            console.log(`\nCreate Tasks in Window: ${createsInWindow.length}`);
            console.log('---------------------');
            createsInWindow.forEach(t => printCreateTask(t, false));

            console.log(`\nDelete Tasks in Window: ${deletesInWindow.length}`);
            console.log('---------------------');
            deletesInWindow.forEach(t => printDeleteTask(t, false));
            
            if (outdatedDeletes.length > 0) {
                console.log(`\nOutdated Delete Tasks: ${outdatedDeletes.length}`);
                console.log('---------------------');
                outdatedDeletes.forEach(t => printDeleteTask(t, false));
            }
        }

        // Print summary (same for both verbose and non-verbose modes)
        console.log('\nSummary:');
        console.log(`Total Create Tasks: ${processedCreates.length}`);
        console.log(`  ├─ Pending: ${pendingCreates.length}`);
        console.log(`  │   └─ In create window: ${createsInWindow.length}`);
        console.log(`  ├─ Executed: ${executedCreates.length}`);
        console.log(`  ├─ Expired: ${expiredCreates.length}`);
        console.log(`  └─ Cancelled: ${cancelledCreates.length}`);
        console.log(`Total Delete Tasks: ${processedDeletes.length}`);
        console.log(`  ├─ Pending: ${pendingDeletes.length}`);
        console.log(`  │   ├─ In delete window: ${deletesInWindow.length}`);
        console.log(`  │   │   ├─ Flowing: ${deletesInWindowFlowing.length}`);
        console.log(`  │   │   └─ Not flowing: ${pendingNotFlowingDeletes.length}`);
        console.log(`  │   └─ Outdated: ${pendingDeletes.length - deletesInWindow.length}`);
        console.log(`  ├─ Executed: ${executedDeletes.length}`);
        console.log(`  ├─ Expired: ${expiredDeletes.length}`);
        console.log(`  ├─ Cancelled: ${cancelledDeletes.length}`);
        console.log(`  └─ Outdated: ${outdatedDeletes.length}`);

    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(`Error processing schedules: ${error.response?.status} ${error.response?.statusText}`);
        } else {
            console.error('Error processing schedules:', error);
        }
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
}

export { FlowScheduleProcessor }; 