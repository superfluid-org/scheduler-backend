# About

Minimal Superfluid [Vesting|Flow|Wrap]Scheduler executor with no runtime dependencies other than an RPC endpoint.

Setup:
```
yarn install
```

Run vesting schedules:
```
RPC=<url> PRIVKEY=<pk> node runVestingSchules.js
```

Run vesting schedules v2:
```
[ENFORCE_ALLOWLIST=true] USE_V2=true RPC=<url> PRIVKEY=<pk> node runVestingSchules.js
```

Run flow schedules:
```
RPC=<url> PRIVKEY=<pk> node runFlowSchules.js
```

Run wrap schedules:
```
RPC=<url> PRIVKEY=<pk> node runWrapSchedule.js
```

For other (optional) env vars, check the source files.

## How it works
* initialize for the RPC defined network (using metadata)
* range query log events of the scheduler contract from latest processed block to latest block and update the local state accordingly
* execute what needs to be executed

The current state is written to a json file named `state_<network>.json`.

The process quits after having processed everything, it's designed to be periodically started, e.g. by a cronjob.
(For robustness, some mechanism to watch and restart on failure would be needed anyway)

You can query state files with jq, e.g.
```
cat data/vestingschedule_polygon-mainnet.json | jq '.activeSchedules[] | select(.started == false and .startDate < now)'
```
gives you the active vesting schedules for Polygon mainnet which are due to be started and weren't yet.

### Allowlist

Since execution of schedules is currently subsidized, there's an allowlist enumerating the accounts for which schedules shall be executed. This list is provided via an API, with a default value preset.  
Currently, enforcement of this list is disabled by default. In order to enable, the env var `ENFORCE_ALLOWLIST=true` needs to be set. Otherwise all accounts will be processes, with extra logging if a schedule doesn't match the allowlist.

The allowlist is loaded from the API url before starting with execution. After loading and parsing it, a copy is persisted locally.
If loading or parsing fails, the previously persisted version is used. If none is available and enforcement is enabled, the script will exit with an error.

## What next?

The current implementation of doing transactions isn't ideal for batches of schedules due at the same time.
Should batch transactions, e.g. using Multicall3.

Writing to an sqlite DB would also be more elegant than just a json file. But in terms of scalability that becomes relevant only with much more usage.
