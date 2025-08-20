import { ProcessorBase } from './processorBase';
import { createPublicClient, http, erc20Abi } from 'viem';
import { superTokenAbi } from "@sfpro/sdk/abi";
import { cfaAbi, gdaAbi } from "@sfpro/sdk/abi/core"; 
import { autoWrapManagerAbi, autoWrapStrategyAbi } from "@sfpro/sdk/abi/automation";
import sfMeta from '@superfluid-finance/metadata';
import chalk from 'chalk';
import { formatDuration } from './processorBase';

interface WrapSchedule {
  id: string;
  wrapScheduleId: string;
  deletedAt: number | null;
  createdAt: number;
  createdBlockNumber: number;
  updatedBlockNumber: number;
  updatedAt: number;
  expiredAt: number;
  strategy: string;
  manager: string;
  account: string;
  liquidityToken: string;
  superToken: string;
  lowerLimit: string;
  upperLimit: string;
  lastExecutedAt: number;
  amount: string;
  isActive: boolean;
}

interface ProcessedWrapSchedule {
  schedule: WrapSchedule;
  due_since: number;
  due_since_with_gda: number;
}

class AutowrapProcessor extends ProcessorBase {
  private readonly rpcUrl: string;
  public readonly networkName: string;

  constructor(subgraphUrl: string, networkName: string, rpcUrl: string) {
    super(subgraphUrl, networkName);
    this.networkName = networkName;
    this.rpcUrl = rpcUrl;
  }

  private async getScheduleStatus(schedule: WrapSchedule): Promise<ProcessedWrapSchedule> {
    const publicClient = createPublicClient({
      transport: http(this.rpcUrl)
    });

    const chainId = await publicClient.getChainId();
    const network = sfMeta.getNetworkByChainId(chainId);
    if (!network) {
      throw new Error(`Network not found for chainId ${chainId}`);
    }

    const cfaAddress = network.contractsV1.cfaV1 as `0x${string}`;
    const gdaAddress = network.contractsV1.gdaV1 as `0x${string}`;

    const now = Math.floor(Date.now() / 1000);

    if (!schedule.isActive || schedule.deletedAt !== null || now >= schedule.expiredAt) {
      return { schedule, due_since: 0, due_since_with_gda: 0 };
    }

    const manager = schedule.manager as `0x${string}`;
    const minLower = await publicClient.readContract({
      address: manager,
      abi: autoWrapManagerAbi,
      functionName: 'minLower',
      args: []
    }) as bigint;

    const account = schedule.account as `0x${string}`;
    const superToken = schedule.superToken as `0x${string}`;
    const liquidityToken = schedule.liquidityToken as `0x${string}`;
    const strategy = schedule.strategy as `0x${string}`;

    const allowance = await publicClient.readContract({
      address: liquidityToken,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account, strategy]
    }) as bigint;

    if (allowance === 0n) {
      return { schedule, due_since: 0, due_since_with_gda: 0 };
    }

    const liqBalance = await publicClient.readContract({
      address: liquidityToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account]
    }) as bigint;

    if (liqBalance === 0n) {
      return { schedule, due_since: 0, due_since_with_gda: 0 };
    }

    const isSupported = await publicClient.readContract({
      address: strategy,
      abi: autoWrapStrategyAbi,
      functionName: 'isSupportedSuperToken',
      args: [superToken]
    }) as boolean;

    if (!isSupported) {
      return { schedule, due_since: 0, due_since_with_gda: 0 };
    }

    const cfaNetFlow = await publicClient.readContract({
      address: cfaAddress,
      abi: cfaAbi,
      functionName: 'getNetFlow',
      args: [superToken, account]
    }) as bigint; // int96 as bigint

    const gdaNetFlow = await publicClient.readContract({
      address: gdaAddress,
      abi: gdaAbi,
      functionName: 'getNetFlow',
      args: [superToken, account]
    }) as bigint;

    const totalNetFlow = cfaNetFlow + gdaNetFlow;
    
    const superBalance = await publicClient.readContract({
      address: superToken,
      abi: superTokenAbi,
      functionName: 'balanceOf',
      args: [account]
    }) as bigint;

    const lowerLimit = BigInt(schedule.lowerLimit);

    const maxLowerLimit = lowerLimit < minLower ? minLower : lowerLimit;
    
    // Calculate due_since based on cfaNetFlow if negative
    let due_since = 0;
    if (cfaNetFlow < 0n) {
      const positiveFlowRate = -cfaNetFlow;
      const threshold = positiveFlowRate * maxLowerLimit;
      
      if (superBalance <= threshold) {
        const delta_t = (threshold - superBalance) / positiveFlowRate;
        due_since = now - Number(delta_t);
      }
    }

    // Calculate due_since_with_gda based on totalNetFlow if negative
    let due_since_with_gda = 0;
    if (totalNetFlow < 0n) {
      const positiveTotal = -totalNetFlow;
      const threshold_gda = positiveTotal * maxLowerLimit;
      if (superBalance <= threshold_gda) {
        const delta_t_gda = (threshold_gda - superBalance) / positiveTotal;
        due_since_with_gda = now - Number(delta_t_gda);
      }
    }

    return { schedule, due_since, due_since_with_gda };
  }

  public async getAutowrapSchedules(): Promise<ProcessedWrapSchedule[]> {
    const queryFn = (lastId: string) => `
      {
        wrapSchedules(
          first: ${this.MAX_ITEMS},
          where: { id_gt: "${lastId}" },
          orderBy: id,
          orderDirection: asc
        ) {
          id
          wrapScheduleId
          deletedAt
          createdAt
          createdBlockNumber
          updatedBlockNumber
          updatedAt
          expiredAt
          strategy
          manager
          account
          liquidityToken
          superToken
          lowerLimit
          upperLimit
          lastExecutedAt
          amount
          isActive
        }
      }
    `;

    const toItems = (res: any) => res.data.data.wrapSchedules;

    const rawSchedules = await this._queryAllPages(queryFn, toItems, (item) => item);

    const processed = await Promise.all(rawSchedules.map(async (schedule) => await this.getScheduleStatus(schedule)));

    return processed;
  }
}

// used only for interactive debugging
async function main() {
  const subgraphUrl = process.env.SUBGRAPH_URL || process.argv[2];
  const rpcUrl = process.env.RPC_URL || process.argv[3];
  
  if (!subgraphUrl) {
    console.error('Please provide a subgraph URL either as SUBGRAPH_URL environment variable or as first command line argument');
    process.exit(1);
  }
  
  if (!rpcUrl) {
    console.error('Please provide an RPC URL either as RPC_URL environment variable or as second command line argument');
    process.exit(1);
  }

  const networkName = process.env.NETWORK_NAME || 'unknown';

  try {
    console.log(`Using subgraph: ${subgraphUrl}`);
    console.log(`Using RPC: ${rpcUrl}`);
    
    const processor = new AutowrapProcessor(subgraphUrl, networkName, rpcUrl);
    const schedules = await processor.getAutowrapSchedules();
    
    // Categorize schedules based on isActive flag in subgraph
    const activeSchedules = schedules.filter(s => s.schedule.isActive && s.schedule.deletedAt === null);
    const inactiveSchedules = schedules.filter(s => !s.schedule.isActive || s.schedule.deletedAt !== null);
    
    // Print active schedules
    console.log('\nActive Autowrap Schedules:');
    console.log('--------------------------');
    
    if (activeSchedules.length === 0) {
      console.log('No active schedules found');
    } else {
      for (const s of activeSchedules) {
        const now = Math.floor(Date.now() / 1000);
        const dueSince = s.due_since > 0 ? now - s.due_since : 0;
        const dueSinceWithGda = s.due_since_with_gda > 0 ? now - s.due_since_with_gda : 0;
        
        // Create the public client for additional metrics
        const publicClient = createPublicClient({
          transport: http(rpcUrl)
        });
        
        // Fetch additional metrics
        const account = s.schedule.account as `0x${string}`;
        const superToken = s.schedule.superToken as `0x${string}`;
        const liquidityToken = s.schedule.liquidityToken as `0x${string}`;
        const strategy = s.schedule.strategy as `0x${string}`;
        
        console.log(`ID: ${s.schedule.id}`);
        console.log(`Account: ${s.schedule.account}`);
        console.log(`SuperToken: ${s.schedule.superToken}`);
        console.log(`LiquidityToken: ${s.schedule.liquidityToken}`);
        
        // Fetch decimals for token formatting
        let decimals = 18n; // Default to 18 if not found
        try {
          const decimalResult = await publicClient.readContract({
            address: superToken,
            abi: [{"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"}],
            functionName: 'decimals'
          });
          decimals = BigInt(Number(decimalResult));
        } catch (e) {
          console.log('Could not get decimals, using 18');
        }
        
        // Helper to format token amounts
        const formatToken = (amount: bigint) => {
          const isNegative = amount < 0n;
          // Work with absolute value for formatting
          const absAmount = isNegative ? -amount : amount;
          const divisor = 10n ** decimals;
          const whole = absAmount / divisor;
          const fraction = absAmount % divisor;
          const paddedFraction = fraction.toString().padStart(Number(decimals), '0');
          const trimmedFraction = paddedFraction.substring(0, 4); // Show only 4 decimal places
          // Add negative sign back if needed
          return `${isNegative ? '-' : ''}${whole}.${trimmedFraction}`;
        };
        
        // Fetch allowance
        const allowance = await publicClient.readContract({
          address: liquidityToken,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [account, strategy]
        }) as bigint;
        
        console.log(`Allowance: ${formatToken(allowance)}`);
        
        // Fetch liquidity balance
        const liqBalance = await publicClient.readContract({
          address: liquidityToken,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account]
        }) as bigint;
        
        console.log(`Liquidity Balance: ${formatToken(liqBalance)}`);
        
        // Fetch superToken balance
        const superBalance = await publicClient.readContract({
          address: superToken,
          abi: superTokenAbi,
          functionName: 'balanceOf',
          args: [account]
        }) as bigint;
        
        console.log(`SuperToken Balance: ${formatToken(superBalance)}`);
        
        // Fetch chain ID for contracts
        const chainId = await publicClient.getChainId();
        const network = sfMeta.getNetworkByChainId(chainId);
        if (!network) {
          console.log(`Network not found for chainId ${chainId}`);
          console.log('--------------------------');
          continue;
        }
        
        const cfaAddress = network.contractsV1.cfaV1 as `0x${string}`;
        const gdaAddress = network.contractsV1.gdaV1 as `0x${string}`;
        
        // Fetch flowrates
        const cfaNetFlow = await publicClient.readContract({
          address: cfaAddress,
          abi: cfaAbi,
          functionName: 'getNetFlow',
          args: [superToken, account]
        }) as bigint;
        
        const gdaNetFlow = await publicClient.readContract({
          address: gdaAddress,
          abi: gdaAbi,
          functionName: 'getNetFlow',
          args: [superToken, account]
        }) as bigint;
        
        const totalNetFlow = cfaNetFlow + gdaNetFlow;
        
        // Format flow rates per month for better readability
        const secondsPerMonth = 30n * 24n * 60n * 60n;
        const formatFlowPerMonth = (flowRate: bigint) => {
          const monthlyFlow = (flowRate * secondsPerMonth);
          return `${formatToken(monthlyFlow)}/month`;
        };
        
        console.log(`CFA Net Flow: ${formatFlowPerMonth(cfaNetFlow)} (${cfaNetFlow.toString()})`);
        console.log(`GDA Net Flow: ${formatFlowPerMonth(gdaNetFlow)} (${gdaNetFlow.toString()})`);
        console.log(`Total Net Flow: ${formatFlowPerMonth(totalNetFlow)} (${totalNetFlow.toString()})`);
        
        // Format time limits in hours/days
        const lowerLimitBigInt = BigInt(s.schedule.lowerLimit);
        const upperLimitBigInt = BigInt(s.schedule.upperLimit);
        const lowerLimitHours = Number(lowerLimitBigInt) / 3600;
        const upperLimitHours = Number(upperLimitBigInt) / 3600;
        
        // Limits and thresholds
        console.log(`Lower Limit: ${lowerLimitHours.toFixed(2)} hours (${s.schedule.lowerLimit} seconds)`);
        console.log(`Upper Limit: ${upperLimitHours.toFixed(2)} hours (${s.schedule.upperLimit} seconds)`);
        
        // Calculate projected time to next execution
        const manager = s.schedule.manager as `0x${string}`;
        const minLower = await publicClient.readContract({
          address: manager,
          abi: autoWrapManagerAbi,
          functionName: 'minLower',
          args: []
        }) as bigint;
        
        const maxLowerLimit = lowerLimitBigInt < minLower ? minLower : lowerLimitBigInt;
        
        // Calculate projections for CFA-only and total flow
        if (cfaNetFlow < 0n) {
          const positiveCfaFlow = -cfaNetFlow;
          const thresholdCfa = positiveCfaFlow * maxLowerLimit;
          
          if (superBalance > thresholdCfa) {
            const timeUntilExecutionCfa = (superBalance - thresholdCfa) / positiveCfaFlow;
            console.log(`CFA-only Projection: Contract execution window opens in ${formatDuration(Number(timeUntilExecutionCfa))}`);
          } else if (s.due_since > 0) {
            console.log(chalk.red.bold(`CFA-only: Contract execution window opened ${formatDuration(dueSince)} ago`));
          }
        } else {
          console.log(`CFA-only: No negative CFA flow - contract execution window won't open`);
        }
        
        if (totalNetFlow < 0n) {
          const positiveTotalFlow = -totalNetFlow;
          const thresholdTotal = positiveTotalFlow * maxLowerLimit;
          
          if (superBalance > thresholdTotal) {
            const timeUntilExecutionTotal = (superBalance - thresholdTotal) / positiveTotalFlow;
            console.log(`Total Flow Projection: Will need execution in ${formatDuration(Number(timeUntilExecutionTotal))}`);
          } else if (s.due_since_with_gda > 0) {
            console.log(chalk.red.bold(`Total Flow: Should be executed (due for ${formatDuration(dueSinceWithGda)})`));
          }
        } else {
          console.log(`Total Flow: No negative flow - execution not needed`);
        }
        
        // Status indicators
        if (s.due_since > 0 || s.due_since_with_gda > 0) {
          console.log(chalk.green.bold('Ready for execution'));
        } else {
          console.log(chalk.yellow('Not yet due for execution'));
        }
        
        console.log('--------------------------');
      }
    }

    // Print summary
    console.log('\nSummary:');
    console.log(`Total Schedules: ${schedules.length}`);
    console.log(`Active: ${activeSchedules.length}`);
    console.log(`Inactive: ${inactiveSchedules.length}`);
    console.log(`Ready for execution: ${schedules.filter(s => s.due_since > 0 || s.due_since_with_gda > 0).length}`);
    
  } catch (error) {
    console.error('Error processing autowrap schedules:', error);
    process.exit(1);
  }
}

// Only run if this file is being executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export { AutowrapProcessor, WrapSchedule, ProcessedWrapSchedule };