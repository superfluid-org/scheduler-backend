# Superfluid Scheduler Prometheus Exporter

A Prometheus exporter for monitoring Superfluid Vesting Scheduler and Autowrap services across networks.

## Running the Exporter

### Using Node.js

```bash
# Install dependencies
yarn install

# Start the exporter
yarn start
```

### Using Docker

```bash
# Build the Docker image
docker build -t superfluid-scheduler-exporter .

# Run the container
docker run -p 9090:9090 superfluid-scheduler-exporter
```

## Environment Variables

- `PORT`: Port to expose the Prometheus metrics endpoint (default: 9090)

## Available Metrics

The exporter exposes metrics at the `/metrics` endpoint.

### Vesting Scheduler Metrics

| Metric Name | Type | Description | Labels |
|------------|------|-------------|--------|
| `vesting_end_overdue` | Gauge | Number of active vesting schedules that have been in the stop window for at least 2 hours | `network` |

### Autowrap Metrics

| Metric Name | Type | Description | Labels |
|------------|------|-------------|--------|
| `autowrap_overdue` | Gauge | Number of autowrap schedules that are overdue for execution | `network` |

## Health Check

The exporter provides a health check endpoint at `/health` which returns HTTP 200 OK when the service is running. 