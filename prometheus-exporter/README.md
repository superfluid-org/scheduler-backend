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
- `OVERDUE_THRESHOLD`: Override the overdue threshold in seconds (default: 7200 = 2 hours)

## Available Metrics

The exporter exposes metrics at the `/metrics` endpoint.

### Vesting Scheduler Metrics

| Metric Name | Type | Description | Labels |
|------------|------|-------------|--------|
| `vesting_start_overdue` | Gauge | Number of vesting schedules that have been ready for start execution for at least 2 hours | `network` |
| `vesting_end_overdue` | Gauge | Number of active vesting schedules that have been in the stop window for at least 2 hours | `network` |
| `vesting_last_successful_update_timestamp` | Gauge | Unix timestamp of the last successful vesting metrics update | `network` |

### Autowrap Metrics

| Metric Name | Type | Description | Labels |
|------------|------|-------------|--------|
| `autowrap_overdue` | Gauge | Number of autowrap schedules that are overdue for execution | `network` |
| `autowrap_last_successful_update_timestamp` | Gauge | Unix timestamp of the last successful autowrap metrics update | `network` |

### Flow Scheduler Metrics

| Metric Name | Type | Description | Labels |
|------------|------|-------------|--------|
| `flow_create_overdue` | Gauge | Number of flow creation schedules that are overdue for execution | `network` |
| `flow_delete_overdue` | Gauge | Number of flow deletion schedules that are overdue for execution | `network` |
| `flow_last_successful_update_timestamp` | Gauge | Unix timestamp of the last successful flow metrics update | `network` |

## Health Check

The exporter provides a health check endpoint at `/health` which returns HTTP 200 OK when the service is running. 

## Note

The current implementation may include false positives in the sense that it would trigger in cases where execution isn't possible due to preconditions (e.g. sender balance, allowance) not being met.