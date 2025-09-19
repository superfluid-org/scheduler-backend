import axios from 'axios';
import { VestingScheduleProcessor } from './vestingScheduleProcessor';
import { FlowScheduleProcessor, DELETE_TASK_OUTDATED_CUTOFF } from './flowScheduleProcessor';
import { AutowrapProcessor } from './autowrapProcessor';
import { ProcessorBase } from './processorBase';
import express from 'express';
import { Registry, Gauge } from 'prom-client';
import { createIncidentHealthy, createIncidentUnhealthy } from './sfInstatus';

const END_DATE_VALID_BEFORE = 24 * 60 * 60; // 1 day in seconds
const OVERDUE_THRESHOLD = parseInt(process.env.OVERDUE_THRESHOLD || '7200', 10); // 2 hours in seconds (default), can be overridden via env var
const UPDATE_INTERVAL = 20 * 60 * 1000; // 20 minutes in milliseconds
const TWO_DAYS = 2 * 24 * 60 * 60; // 2 days in seconds

// Environment variable to enable/disable Instatus reporting
const ENABLE_INSTATUS_REPORTING = process.env.ENABLE_INSTATUS_REPORTING === 'true';

class Exporter {
    private readonly processors: ProcessorBase[];
    private readonly registry: Registry;

    // gauges
    private readonly vestingEndOverdueGauge: Gauge;
    private readonly autowrapOverdueGauge: Gauge;
    private readonly vestingStartOverdueGauge: Gauge;
    private readonly flowCreateOverdueGauge: Gauge;
    private readonly flowDeleteOverdueGauge: Gauge;

    // staleness gauges
    private readonly vestingLastSuccessfulUpdate: Gauge;
    private readonly autowrapLastSuccessfulUpdate: Gauge;
    private readonly flowLastSuccessfulUpdate: Gauge;

    private updateTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.processors = [];
        this.registry = new Registry();
        
        // Log Instatus reporting status
        if (ENABLE_INSTATUS_REPORTING) {
            console.log('Instatus reporting is ENABLED');
        } else {
            console.log('Instatus reporting is DISABLED (set ENABLE_INSTATUS_REPORTING=true to enable)');
        }
        
        this.vestingStartOverdueGauge = new Gauge({
            name: 'vesting_start_overdue',
            help: 'Number of vesting schedules that have been ready for start execution for at least 2 hours',
            labelNames: ['network'],
            registers: [this.registry]
        });

        this.vestingEndOverdueGauge = new Gauge({
            name: 'vesting_end_overdue',
            help: 'Number of active vesting schedules that have been in the stop window for at least 2 hours',
            labelNames: ['network'],
            registers: [this.registry]
        });

        this.flowCreateOverdueGauge = new Gauge({
            name: 'flow_create_overdue',
            help: 'Number of flow creation schedules that are overdue for execution',
            labelNames: ['network'],
            registers: [this.registry]
        });

        this.flowDeleteOverdueGauge = new Gauge({
            name: 'flow_delete_overdue',
            help: 'Number of flow deletion schedules that are overdue for execution',
            labelNames: ['network'],
            registers: [this.registry]
        });

        this.autowrapOverdueGauge = new Gauge({
            name: 'autowrap_overdue',
            help: 'Number of autowrap schedules that are overdue for execution',
            labelNames: ['network'],
            registers: [this.registry]
        });

        
        this.vestingLastSuccessfulUpdate = new Gauge({
            name: 'vesting_last_successful_update_timestamp',
            help: 'Unix timestamp of the last successful vesting metrics update',
            labelNames: ['network'],
            registers: [this.registry]
        });
        
        this.autowrapLastSuccessfulUpdate = new Gauge({
            name: 'autowrap_last_successful_update_timestamp',
            help: 'Unix timestamp of the last successful autowrap metrics update',
            labelNames: ['network'],
            registers: [this.registry]
        });
        
        this.flowLastSuccessfulUpdate = new Gauge({
            name: 'flow_last_successful_update_timestamp',
            help: 'Unix timestamp of the last successful flow metrics update',
            labelNames: ['network'],
            registers: [this.registry]
        });
    }

    private async init() {
        const sfMetaModule = await import('@superfluid-finance/metadata');
        const sfMeta = sfMetaModule.default;
        const networks = sfMeta.networks;
        
        console.log('\nInitializing networks:');
        
        networks.forEach(network => {
            const contracts = network.contractsV1 || {};
            const hasVestingScheduler = contracts.vestingScheduler || 
                                       contracts.vestingSchedulerV2 || 
                                       contracts.vestingSchedulerV3;
            const hasAutowrapManager = contracts.autowrap?.manager;
            
            if (hasVestingScheduler) {
                const vestingSubgraphUrl = network.subgraphVesting?.hostedEndpoint || 
                    `https://subgraph-endpoints.superfluid.dev/${network.name}/vesting-scheduler?app=scheduler-exporter-s73gi3`;
                console.log(`- ${network.name}: Adding VestingScheduleProcessor - ${vestingSubgraphUrl}`);
                this.processors.push(new VestingScheduleProcessor(vestingSubgraphUrl, network.name));
            }
            
            if (hasAutowrapManager) {
                const autowrapSubgraphUrl = network.subgraphAutoWrap?.hostedEndpoint || 
                    `https://subgraph-endpoints.superfluid.dev/${network.name}/auto-wrap?app=scheduler-exporter-s73gi3`;
                const rpcUrl = `https://${network.name}.rpc.x.superfluid.dev?app=scheduler-exporter-s73gi3`;
                console.log(`- ${network.name}: Adding AutowrapProcessor - ${autowrapSubgraphUrl}`);
                this.processors.push(new AutowrapProcessor(autowrapSubgraphUrl, network.name, rpcUrl));
            }

            if (contracts.flowScheduler) {
                const flowSubgraphUrl = network.subgraphFlowScheduler?.hostedEndpoint || 
                    `https://subgraph-endpoints.superfluid.dev/${network.name}/flow-scheduler?app=scheduler-exporter-s73gi3`;
                const rpcUrl = `https://${network.name}.rpc.x.superfluid.dev?app=scheduler-exporter-s73gi3`;
                console.log(`- ${network.name}: Adding FlowScheduleProcessor - ${flowSubgraphUrl}`);
                this.processors.push(new FlowScheduleProcessor(flowSubgraphUrl, network.name, rpcUrl));
            }
            
            if (!hasVestingScheduler && !hasAutowrapManager) {
                console.log(`- ${network.name}: No supported contracts found, skipping`);
            }
        });
        
        console.log(`Total processors initialized: ${this.processors.length}\n`);
    }

    private async updateMetrics() {
        // get the processors of each type
        const vestingProcessors = this.processors.filter(processor => processor instanceof VestingScheduleProcessor) as VestingScheduleProcessor[];
        const autowrapProcessors = this.processors.filter(processor => processor instanceof AutowrapProcessor) as AutowrapProcessor[];
        const flowProcessors = this.processors.filter(p => p instanceof FlowScheduleProcessor) as FlowScheduleProcessor[];
        
        await Promise.all([
            this.updateVestingMetrics(vestingProcessors),
            this.updateAutowrapMetrics(autowrapProcessors),
            this.updateFlowMetrics(flowProcessors)
        ]);
    }

    private async updateVestingMetrics(vestingProcessors: VestingScheduleProcessor[]) {
        for (const processor of vestingProcessors) {
            try {
                const schedules = await processor.getVestingSchedules();
                const now = Math.floor(Date.now() / 1000);
                
                // Count schedules that are overdue for end execution
                const endOverdueCount = schedules.filter(schedule => {
                    if (!schedule.isInStopWindow) return false;
                    
                    const timeInStopWindow = now - (schedule.schedule.endDate - END_DATE_VALID_BEFORE);
                    return timeInStopWindow >= OVERDUE_THRESHOLD;
                }).length;

                // Count auto-start schedules that are overdue for start execution
                const startOverdueCount = schedules.filter(schedule => {
                    if (!schedule.isInStartWindow) return false;
                    if (schedule.isClaimable) return false; // Only auto-start schedules
                    
                    const timeInStartWindow = now - schedule.schedule.cliffAndFlowDate;
                    return timeInStartWindow >= OVERDUE_THRESHOLD;
                }).length;

                // Create incidents based on overdue counts (only if Instatus reporting is enabled)
                if (ENABLE_INSTATUS_REPORTING) {
                    // Zero count = healthy, greater than zero = unhealthy
                    if (startOverdueCount === 0) {
                        await createIncidentHealthy(processor.networkName, 'vesting_scheduler');
                    } else {
                        await createIncidentUnhealthy(processor.networkName, 'vesting_scheduler');
                    }
                }

                // Find schedules ending in next 2 days
                const endingSoon = schedules
                    .filter(schedule => {
                        if (schedule.status !== 'active') return false;
                        const timeUntilEnd = schedule.schedule.endDate - now;
                        return timeUntilEnd > 0 && timeUntilEnd <= TWO_DAYS;
                    })
                    .sort((a, b) => b.schedule.endDate - a.schedule.endDate);

                // Update the gauge with network label
                this.vestingEndOverdueGauge.set({ network: processor.networkName }, endOverdueCount);
                this.vestingStartOverdueGauge.set({ network: processor.networkName }, startOverdueCount);

                console.log(`[${new Date().toISOString()}] ${processor.networkName} - Updated vesting metrics:`);
                console.log(`  - Start overdue: ${startOverdueCount}`);
                console.log(`  - End overdue: ${endOverdueCount}`);
                
                // Log schedules ending soon
                if (endingSoon.length > 0) {
                    console.log(`\n${processor.networkName} - Vesting Schedules ending in next 2 days:`);
                    console.log('----------------');
                    endingSoon.forEach(schedule => {
                        const timeUntilEnd = schedule.schedule.endDate - now;
                        const hours = Math.floor(timeUntilEnd / 3600);
                        const minutes = Math.floor((timeUntilEnd % 3600) / 60);
                        
                        console.log(`ID: ${schedule.schedule.id}`);
                        console.log(`SuperToken: ${schedule.schedule.superToken}`);
                        console.log(`Receiver: ${schedule.schedule.receiver}`);
                        console.log(`Ends in: ${hours}h ${minutes}m`);
                        console.log(`End date: ${new Date(schedule.schedule.endDate * 1000).toISOString()}`);
                        console.log('----------------');
                    });
                }

                this.vestingLastSuccessfulUpdate.set({ network: processor.networkName }, now);
            } catch (error) {
                if (axios.isAxiosError(error)) {
                    console.error(`Error updating vesting metrics for ${processor.networkName}: ${error.response?.status} ${error.response?.statusText}`);
                } else {
                    console.error(`Error updating vesting metrics for ${processor.networkName}:`, error);
                }
            }
        }
    }

    private async updateFlowMetrics(flowProcessors: FlowScheduleProcessor[]) {
        for (const processor of flowProcessors) {
            try {
                const processedCreates = await processor.getProcessedCreateTasks();
                const processedDeletes = await processor.getProcessedDeleteTasks();
                const now = Math.floor(Date.now() / 1000);
                
                // Count create tasks that are overdue for execution
                const createOverdue = processedCreates.filter(t => {
                    if (!t.isInCreateWindow) return false;
                    const timeInWindow = now - t.task.startDate;
                    return timeInWindow >= OVERDUE_THRESHOLD;
                }).length;

                // Count delete tasks that are overdue for execution
                // Only count tasks that are: in window, flowing, and not outdated
                const deleteOverdue = processedDeletes.filter(t => {
                    if (t.status !== 'pending') return false; // Only pending tasks
                    if (!t.isInDeleteWindow) return false; // Must be in delete window
                    if (t.isNotFlowing) return false; // Must have active flow
                    
                    const timeInWindow = now - t.task.executionAt;
                    if (timeInWindow > DELETE_TASK_OUTDATED_CUTOFF) return false; // Must not be outdated
                    
                    return timeInWindow >= OVERDUE_THRESHOLD; // Must be overdue
                }).length;

                // Create incidents based on overdue counts (only if Instatus reporting is enabled)
                if (ENABLE_INSTATUS_REPORTING) {
                    // Zero count = healthy, greater than zero = unhealthy
                    const totalOverdue = createOverdue + deleteOverdue;
                    if (totalOverdue === 0) {
                        await createIncidentHealthy(processor.networkName, 'flow_scheduler');
                    } else {
                        await createIncidentUnhealthy(processor.networkName, 'flow_scheduler');
                    }
                }

                this.flowCreateOverdueGauge.set({ network: processor.networkName }, createOverdue);
                this.flowDeleteOverdueGauge.set({ network: processor.networkName }, deleteOverdue);

                console.log(`[${new Date().toISOString()}] ${processor.networkName} - Updated flow metrics. Create overdue: ${createOverdue}, Delete overdue: ${deleteOverdue}`);

                this.flowLastSuccessfulUpdate.set({ network: processor.networkName }, now);
            } catch (error) {
                if (axios.isAxiosError(error)) {
                    console.error(`Error updating flow metrics for ${processor.networkName}: ${error.response?.status} ${error.response?.statusText}`);
                } else {
                    console.error(`Error updating flow metrics for ${processor.networkName}:`, error);
                }
            }
        }
    }

    private async updateAutowrapMetrics(autowrapProcessors: AutowrapProcessor[]) {
        for (const processor of autowrapProcessors) {
            try {
                const schedules = await processor.getAutowrapSchedules();
                const now = Math.floor(Date.now() / 1000);
                
                // Count schedules that are overdue
                const overdueCount = schedules.filter(schedule => {
                    return schedule.due_since > 0 && (now - schedule.due_since) > OVERDUE_THRESHOLD;
                }).length;

                // Create incidents based on overdue counts (only if Instatus reporting is enabled)
                if (ENABLE_INSTATUS_REPORTING) {
                    // Zero count = healthy, greater than zero = unhealthy
                    if (overdueCount === 0) {
                        await createIncidentHealthy(processor.networkName, 'wrap_scheduler');
                    } else {
                        await createIncidentUnhealthy(processor.networkName, 'wrap_scheduler');
                    }
                }

                // Update the gauge with network label
                this.autowrapOverdueGauge.set({ network: processor.networkName }, overdueCount);
                
                console.log(`[${new Date().toISOString()}] ${processor.networkName} - Updated autowrap metrics. Overdue schedules: ${overdueCount}`);

                this.autowrapLastSuccessfulUpdate.set({ network: processor.networkName }, now);
            } catch (error) {
                if (axios.isAxiosError(error)) {
                    console.error(`Error updating autowrap metrics for ${processor.networkName}: ${error.response?.status} ${error.response?.statusText}`);
                } else {
                    console.error(`Error updating autowrap metrics for ${processor.networkName}:`, error);
                }
            }
        }
    }


    public async start(port: number = 9090) {
        await this.init();
        // Create Express app
        const app = express();

        // Metrics endpoint
        app.get('/metrics', async (req, res) => {
            try {
                res.set('Content-Type', this.registry.contentType);
                res.end(await this.registry.metrics());
            } catch (error) {
                res.status(500).end(error);
            }
        });

        // Health check endpoint
        app.get('/health', (req, res) => {
            res.status(200).send('OK');
        });

        // Start the server
        app.listen(port, () => {
            console.log(`Exporter listening on port ${port}`);
        });

        // Initial metrics update
        await this.updateMetrics();

        // Schedule periodic updates
        this.updateTimer = setInterval(() => this.updateMetrics(), UPDATE_INTERVAL);
    }

    public stop() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
    }
}

// Only run if this file is being executed directly
if (require.main === module) {
    const port = parseInt(process.env.PORT || '9090', 10);
    const exporter = new Exporter();

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
        console.log('SIGTERM received, shutting down...');
        exporter.stop();
        process.exit(0);
    });

    process.on('SIGINT', () => {
        console.log('SIGINT received, shutting down...');
        exporter.stop();
        process.exit(0);
    });

    exporter.start(port).catch(error => {
        console.error('Failed to start exporter:', error);
        process.exit(1);
    });
}

export { Exporter };
