import axios, { AxiosResponse } from 'axios';
import { ProcessorBase } from './processorBase';
import chalk from 'chalk';
import { formatDuration } from './processorBase';

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
    status: 'pending' | 'executed' | 'expired' | 'cancelled';
    isInDeleteWindow: boolean;
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
     * Determines the status and window state of a delete task
     */
    private getDeleteTaskStatus(task: DeleteTask): ProcessedDeleteTask {
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

        // Delete window: endDate <= now (no closing time)
        const isInDeleteWindow = status === 'pending' &&
            task.executionAt > 0 && // Task has an execution date
            now >= task.executionAt; // Execution date has passed

        return {
            task,
            status,
            isInDeleteWindow
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
        return deleteTasks.map(task => this.getDeleteTaskStatus(task));
    }

}

async function main() {
    const subgraphUrl = process.env.SUBGRAPH_URL || process.argv[2];
    if (!subgraphUrl) {
        console.error('Please provide a subgraph URL either as SUBGRAPH_URL environment variable or as command line argument');
        process.exit(1);
    }

    const verbose = process.env.VERBOSE === 'true';

    try {
        const processor = new FlowScheduleProcessor(subgraphUrl, 'unknown', ''); // RPC not needed for this

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

        // Additional categorization for hierarchical summary
        const createsInWindow = pendingCreates.filter(t => t.isInCreateWindow);
        const deletesInWindow = pendingDeletes.filter(t => t.isInDeleteWindow);

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
            
            if (t.isInDeleteWindow) {
                const timeSinceInWindow = now - t.task.executionAt;
                console.log(chalk.yellow.bold(`(Can be executed now - in window for ${formatDuration(timeSinceInWindow)})`));
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

        } else {
            // Non-verbose mode: only show tasks in execution windows
            console.log(`\nCreate Tasks in Window: ${createsInWindow.length}`);
            console.log('---------------------');
            createsInWindow.forEach(t => printCreateTask(t, false));

            console.log(`\nDelete Tasks in Window: ${deletesInWindow.length}`);
            console.log('---------------------');
            deletesInWindow.forEach(t => printDeleteTask(t, false));
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
        console.log(`  │   └─ In delete window: ${deletesInWindow.length}`);
        console.log(`  ├─ Executed: ${executedDeletes.length}`);
        console.log(`  ├─ Expired: ${expiredDeletes.length}`);
        console.log(`  └─ Cancelled: ${cancelledDeletes.length}`);

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