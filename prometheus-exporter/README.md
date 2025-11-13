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

## Instatus Integration

The exporter supports optional integration with Instatus for automatic status page incident creation.

### Configuration

- `ENABLE_INSTATUS_REPORTING`: Enable/disable Instatus reporting (default: `false`)
- `INSTATUS_API_KEY`: Your Instatus API key (required when Instatus reporting is enabled)
- `instatus-components.json`: Component configuration file (required when Instatus reporting is enabled)

### Docker Usage with Instatus

```bash
# With Instatus reporting enabled
docker run -d \
  --name superfluid-exporter \
  -p 9090:9090 \
  -v $(pwd)/instatus-components.json:/app/instatus-components.json:ro \
  -e ENABLE_INSTATUS_REPORTING=true \
  -e INSTATUS_API_KEY=xxxxxxxxxxxxxxxxxxxxx \
  superfluid-scheduler-exporter

# Without Instatus reporting (Prometheus only)
docker run -d \
  --name superfluid-exporter \
  -p 9090:9090 \
  -e ENABLE_INSTATUS_REPORTING=false \
  superfluid-scheduler-exporter
```

### How It Works

The exporter automatically creates Instatus incidents based on scheduler health:

- **Zero overdue items = Healthy**: Creates an "OPERATIONAL" incident
- **Greater than zero overdue items = Unhealthy**: Creates a "PARTIALOUTAGE" incident

Incidents are created for each processor type:
- **Vesting Scheduler**: Monitors overdue start and end schedules
- **Flow Scheduler**: Monitors overdue create and delete tasks
- **Autowrap Scheduler**: Monitors overdue wrap schedules

### Component Configuration

The `instatus-components.json` file maps networks to their Instatus component IDs. Each network has a single component ID that represents all three scheduler types (vesting, flow, and wrap). If any of the three schedulers are unhealthy for a network, the same component is updated. The `pageId` is shared across all networks:

```json
{
  "pageId": "your-page-id",
  "networks": {
    "base-mainnet": {
      "id": "component-id-1"
    },
    "eth-mainnet": {
      "id": "component-id-2"
    }
  }
}
```

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
