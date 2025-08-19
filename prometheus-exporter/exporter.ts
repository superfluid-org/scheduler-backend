import { VestingScheduleProcessor } from './vestingScheduleProcessor';
import { AutowrapProcessor } from './autowrapProcessor';
import { ProcessorBase } from './processorBase';
import express from 'express';
import { Registry, Gauge } from 'prom-client';
import sfMeta from '@superfluid-finance/metadata';
import axios from 'axios';

const END_DATE_VALID_BEFORE = 24 * 60 * 60; // 1 day in seconds
const OVERDUE_THRESHOLD = 2 * 60 * 60; // 2 hours in seconds
const UPDATE_INTERVAL = 20 * 60 * 1000; // 20 minutes in milliseconds
const TWO_DAYS = 2 * 24 * 60 * 60; // 2 days in seconds

class Exporter {
    private readonly processors: ProcessorBase[];
    private readonly registry: Registry;
    private readonly vestingEndOverdueGauge: Gauge;
    private readonly autowrapOverdueGauge: Gauge;
    private updateTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.processors = [];
        this.registry = new Registry();
        
        // Create the vesting gauge metric with network label
        this.vestingEndOverdueGauge = new Gauge({
            name: 'vesting_end_overdue',
            help: 'Number of active vesting schedules that have been in the stop window for at least 2 hours',
            labelNames: ['network'],
            registers: [this.registry]
        });

        // Create the autowrap gauge metric with network label
        this.autowrapOverdueGauge = new Gauge({
            name: 'autowrap_overdue',
            help: 'Number of autowrap schedules that are overdue for execution',
            labelNames: ['network'],
            registers: [this.registry]
        });

        this.initializeProcessors();
    }

    // create a processor for all schedulers on all networks
    private initializeProcessors() {
        const networks = sfMeta.networks.filter(network => !network.isTestnet);
        
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
        
        await Promise.all([
            this.updateVestingMetrics(vestingProcessors),
            this.updateAutowrapMetrics(autowrapProcessors)
        ]);
    }

    private async updateVestingMetrics(vestingProcessors: VestingScheduleProcessor[]) {
        try {
            for (const processor of vestingProcessors) {
                const schedules = await processor.getVestingSchedules();
                const now = Math.floor(Date.now() / 1000);
                
                // Count schedules that are overdue
                const overdueCount = schedules.filter(schedule => {
                    if (schedule.status !== 'active') return false;
                    
                    const timeInStopWindow = now - (schedule.schedule.endDate - END_DATE_VALID_BEFORE);
                    return timeInStopWindow >= OVERDUE_THRESHOLD;
                }).length;

                // Find schedules ending in next 2 days
                const endingSoon = schedules
                    .filter(schedule => {
                        if (schedule.status !== 'active') return false;
                        const timeUntilEnd = schedule.schedule.endDate - now;
                        return timeUntilEnd > 0 && timeUntilEnd <= TWO_DAYS;
                    })
                    .sort((a, b) => b.schedule.endDate - a.schedule.endDate);

                // Update the gauge with network label
                this.vestingEndOverdueGauge.set({ network: processor.networkName }, overdueCount);
                
                // Log metrics update
                console.log(`[${new Date().toISOString()}] ${processor.networkName} - Updated vesting metrics. Overdue schedules: ${overdueCount}`);
                
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
            }
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error(`Error updating vesting metrics: ${error.response?.status} ${error.response?.statusText}`);
            } else {
                console.error('Error updating vesting metrics:', error);
            }
        }
    }

    private async updateAutowrapMetrics(autowrapProcessors: AutowrapProcessor[]) {
        try {
            for (const processor of autowrapProcessors) {
                const schedules = await processor.getAutowrapSchedules();
                const now = Math.floor(Date.now() / 1000);
                
                // Count schedules that are overdue
                const overdueCount = schedules.filter(schedule => {
                    return schedule.due_since > 0 && (now - schedule.due_since) > OVERDUE_THRESHOLD;
                }).length;

                // Update the gauge with network label
                this.autowrapOverdueGauge.set({ network: processor.networkName }, overdueCount);
                
                console.log(`[${new Date().toISOString()}] ${processor.networkName} - Updated autowrap metrics. Overdue schedules: ${overdueCount}`);
            }
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error(`Error updating autowrap metrics: ${error.response?.status} ${error.response?.statusText}`);
            } else {
                console.error('Error updating autowrap metrics:', error);
            }
        }
    }

    public async start(port: number = 9090) {
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