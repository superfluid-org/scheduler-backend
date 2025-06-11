import { VestingScheduleProcessor } from './vestingScheduleProcessor';
import express from 'express';
import { Registry, Gauge } from 'prom-client';

const END_DATE_VALID_BEFORE = 24 * 60 * 60; // 1 day in seconds
const OVERDUE_THRESHOLD = 2 * 60 * 60; // 2 hours in seconds
const UPDATE_INTERVAL = 20 * 60 * 1000; // 20 minutes in milliseconds
const TWO_DAYS = 2 * 24 * 60 * 60; // 2 days in seconds

class VestingScheduleExporter {
    private readonly processor: VestingScheduleProcessor;
    private readonly registry: Registry;
    private readonly vestingEndOverdueGauge: Gauge;
    private updateTimer: NodeJS.Timeout | null = null;

    constructor(subgraphUrl: string) {
        this.processor = new VestingScheduleProcessor(subgraphUrl);
        this.registry = new Registry();
        
        // Create the gauge metric
        this.vestingEndOverdueGauge = new Gauge({
            name: 'vesting_end_overdue',
            help: 'Number of active vesting schedules that have been in the stop window for at least 2 hours',
            registers: [this.registry]
        });
    }

    private async updateMetrics() {
        try {
            const schedules = await this.processor.processSchedules();
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
                .sort((a, b) => a.schedule.endDate - b.schedule.endDate);

            // Update the gauge
            this.vestingEndOverdueGauge.set(overdueCount);
            
            // Log metrics update
            console.log(`[${new Date().toISOString()}] Updated metrics. Overdue schedules: ${overdueCount}`);
            
            // Log schedules ending soon
            if (endingSoon.length > 0) {
                console.log('\nSchedules ending in next 2 days:');
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
    const subgraphUrl = process.env.SUBGRAPH_URL;
    if (!subgraphUrl) {
        console.error('Please provide a subgraph URL via SUBGRAPH_URL environment variable');
        process.exit(1);
    }

    const port = parseInt(process.env.PORT || '9090', 10);
    const exporter = new VestingScheduleExporter(subgraphUrl);

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