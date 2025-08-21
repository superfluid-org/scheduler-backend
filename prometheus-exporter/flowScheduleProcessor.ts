import axios, { AxiosResponse } from 'axios';
import { ProcessorBase } from './processorBase';
import { createPublicClient, http } from 'viem';
import chalk from 'chalk';
import { formatDuration } from './processorBase';

const OVERDUE_THRESHOLD = 2 * 60 * 60; // 2 hours

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
        const itemFn = (item: CreateTask) => item;
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

    private async getCurrentFlowRate(superToken: string, sender: string, receiver: string): Promise<bigint> {
        const publicClient = createPublicClient({
            transport: http(this.rpcUrl)
        });
        
        const chainId = await publicClient.getChainId();
        const sfMetaModule = await import('@superfluid-finance/metadata');
        const sfMeta = sfMetaModule.default;
        const network = sfMeta.getNetworkByChainId(chainId);
        if (!network) throw new Error(`Network not found for chainId ${chainId}`);
        const cfaAddress = network.contractsV1.cfaV1 as `0x${string}`;
        
        const cfaModule = await import("@sfpro/sdk/abi/core");
        const cfaAbi = cfaModule.cfaAbi;
        
        const [timestamp, flowRate, deposited, owed] = await publicClient.readContract({
            address: cfaAddress,
            abi: cfaAbi,
            functionName: 'getFlow',
            args: [superToken as `0x${string}`, sender as `0x${string}`, receiver as `0x${string}`]
        }) as [bigint, bigint, bigint, bigint];
        return flowRate;
    }

    public async getOverdueCounts(): Promise<{ createOverdue: number; deleteOverdue: number }> {
        const now = Math.floor(Date.now() / 1000);
        
        const createTasks = await this.getCreateTasks();
        const pendingCreates = createTasks.filter(t => t.executedAt === null && t.cancelledAt === null);
        
        const createOverdue = pendingCreates.filter(t => {
            const timeSinceStart = now - t.executionAt;
            return timeSinceStart >= OVERDUE_THRESHOLD && now < t.expirationAt;
        }).length;
        
        const deleteTasks = await this.getDeleteTasks();
        const pendingDeletes = deleteTasks.filter(t => t.executedAt === null && t.cancelledAt === null);
        
        let deleteOverdue = 0;
        for (const task of pendingDeletes) {
            const timeSinceEnd = now - task.executionAt;
            if (timeSinceEnd >= OVERDUE_THRESHOLD) {
                const flowRate = await this.getCurrentFlowRate(task.superToken, task.sender, task.receiver);
                if (flowRate > 0n) {
                    deleteOverdue++;
                }
            }
        }
        
        return { createOverdue, deleteOverdue };
    }
}

async function main() {
    const subgraphUrl = process.env.SUBGRAPH_URL || process.argv[2];
    if (!subgraphUrl) {
        console.error('Please provide a subgraph URL either as SUBGRAPH_URL environment variable or as command line argument');
        process.exit(1);
    }

    try {
        const processor = new FlowScheduleProcessor(subgraphUrl, 'unknown', ''); // RPC not needed for this

        const createTasks = await processor.getCreateTasks();
        const deleteTasks = await processor.getDeleteTasks();

        const now = Math.floor(Date.now() / 1000);

        // Categorize create tasks
        const pendingCreates = createTasks.filter(t => t.executedAt === null && t.cancelledAt === null && now < t.expirationAt);
        const executedCreates = createTasks.filter(t => t.executedAt !== null);
        const expiredCreates = createTasks.filter(t => t.executedAt === null && t.cancelledAt === null && now >= t.expirationAt);
        const cancelledCreates = createTasks.filter(t => t.cancelledAt !== null);

        // Categorize delete tasks
        const pendingDeletes = deleteTasks.filter(t => t.executedAt === null && t.cancelledAt === null && now < t.expirationAt);
        const executedDeletes = deleteTasks.filter(t => t.executedAt !== null);
        const expiredDeletes = deleteTasks.filter(t => t.executedAt === null && t.cancelledAt === null && now >= t.expirationAt);
        const cancelledDeletes = deleteTasks.filter(t => t.cancelledAt !== null);

        // Print pending creates (always)
        console.log('\nPending Create Tasks:');
        console.log('---------------------');
        pendingCreates.forEach(t => {
            const timeUntilExecution = t.executionAt - now;
            console.log(`ID: ${t.id}`);
            console.log(`SuperToken: ${t.superToken}`);
            console.log(`Sender: ${t.sender}`);
            console.log(`Receiver: ${t.receiver}`);
            console.log(`Flow Rate: ${t.flowRate}`);
            console.log(`Time until execution: ${formatDuration(timeUntilExecution)}`);
            if (timeUntilExecution < 0) {
                console.log(chalk.yellow.bold('(Overdue)'));
            }
            console.log('----------------');
        });

        console.log('\nPending Delete Tasks:');
        console.log('---------------------');
        pendingDeletes.forEach(t => {
            const timeUntilExecution = t.executionAt - now;
            console.log(`ID: ${t.id}`);
            console.log(`SuperToken: ${t.superToken}`);
            console.log(`Sender: ${t.sender}`);
            console.log(`Receiver: ${t.receiver}`);
            console.log(`Time until execution: ${formatDuration(timeUntilExecution)}`);
            if (timeUntilExecution < 0) {
                console.log(chalk.yellow.bold('(Overdue)'));
            }
            console.log('----------------');
        });

        // Print summary
        console.log('\nSummary:');
        console.log(`Total Create Tasks: ${createTasks.length}`);
        console.log(`Pending Creates: ${pendingCreates.length}`);
        console.log(`Executed Creates: ${executedCreates.length}`);
        console.log(`Expired Creates: ${expiredCreates.length}`);
        console.log(`Cancelled Creates: ${cancelledCreates.length}`);
        console.log(`Total Delete Tasks: ${deleteTasks.length}`);
        console.log(`Pending Deletes: ${pendingDeletes.length}`);
        console.log(`Executed Deletes: ${executedDeletes.length}`);
        console.log(`Expired Deletes: ${expiredDeletes.length}`);
        console.log(`Cancelled Deletes: ${cancelledDeletes.length}`);

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