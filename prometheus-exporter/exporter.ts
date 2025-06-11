import { VestingScheduleProcessor } from './vestingScheduleProcessor';
import express from 'express';
import { Registry, Gauge } from 'prom-client';
import sfMeta from '@superfluid-finance/metadata';

const END_DATE_VALID_BEFORE = 24 * 60 * 60; // 1 day in seconds
const OVERDUE_THRESHOLD = 2 * 60 * 60; // 2 hours in seconds
const UPDATE_INTERVAL = 20 * 60 * 1000; // 20 minutes in milliseconds
const TWO_DAYS = 2 * 24 * 60 * 60; // 2 days in seconds

class VestingScheduleExporter {
    private readonly processors: Map<string, VestingScheduleProcessor>;
    private readonly registry: Registry;
    private readonly vestingEndOverdueGauge: Gauge;
    private updateTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.processors = new Map();
        this.registry = new Registry();
        
        // Create the gauge metric with network label
        this.vestingEndOverdueGauge = new Gauge({
            name: 'vesting_end_overdue',
            help: 'Number of active vesting schedules that have been in the stop window for at least 2 hours',
            labelNames: ['network'],
            registers: [this.registry]
        });

        // Initialize networks
        this.initializeNetworks();
    }

    private initializeNetworks() {
        const supportedNetworks = sfMeta.networks
            .filter(network => {
                if (network.isTestnet) return false;
                
                const contracts = network.contractsV1 || {};
                return contracts.vestingScheduler || 
                       contracts.vestingSchedulerV2 || 
                       contracts.vestingSchedulerV3;
            })
            .map(network => ({
                name: network.name,
                subgraphUrl: `https://subgraph-endpoints.superfluid.dev/${network.name}/vesting-scheduler?app=scheduler-exporter-s73gi3`
            }));

        // Log network configurations
        console.log('\nInitializing networks:');
        supportedNetworks.forEach(network => {
            console.log(`- ${network.name}: ${network.subgraphUrl}`);
            this.processors.set(network.name, new VestingScheduleProcessor(network.subgraphUrl));
        });
        console.log(`Total networks: ${supportedNetworks.length}\n`);
    }

    private async updateMetrics() {
        try {
            for (const [networkName, processor] of this.processors) {
                const schedules = await processor.processSchedules();
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
                this.vestingEndOverdueGauge.set({ network: networkName }, overdueCount);
                
                // Log metrics update
                console.log(`[${new Date().toISOString()}] ${networkName} - Updated metrics. Overdue schedules: ${overdueCount}`);
                
                // Log schedules ending soon
                if (endingSoon.length > 0) {
                    console.log(`\n${networkName} - Schedules ending in next 2 days:`);
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
            console.error('Error updating metrics:', error);
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
            console.log(`Vesting schedule exporter listening on port ${port}`);
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
    const exporter = new VestingScheduleExporter();

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

export { VestingScheduleExporter }; 