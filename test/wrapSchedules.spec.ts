import { expect } from "chai";
import { ethers } from "hardhat";
import { TestBase } from "./helpers/TestBase";

// Need to place this before loading the runWrapSchedules module
process.env.START_BLOCK = process.env.TESTING_START_BLOCK;
import { run } from "../src/runWrapSchedules";
import { getNetwork } from "../src/schedulerCommon";
import * as fs from "fs";
import * as path from "path";

describe("Wrap Schedules Execution", function() {
  let testBase: TestBase;
  let wrapManager: any;
  let impersonatedSigner: any;
  let network: any;
  const dataDir = "data/test";

  before(async function() {
    // Clean up test data directory
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    // Ensure test data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    testBase = new TestBase();
    
    // Get network info from the forked chain
    const chainId = await testBase.provider.getNetwork().then((net: any) => Number(net.chainId));
    network = getNetwork(chainId);
    console.log(`Testing on forked network: ${network.name} (chainId: ${chainId})`);

    // Impersonate a known funded account
    const fundedAddress = "0x119324528d9358c41cc2e8af4e71248a1d52dd73";
    impersonatedSigner = await testBase.impersonateAccount(fundedAddress);
    console.log("Impersonated signer:", await impersonatedSigner.getAddress());

    // Get the Wrap Manager contract instance
    const WrapManagerAbi = require("../src/abis/WrapManagerAbi.json");
    const wrapMgrAddr = network.contractsV1?.autowrap?.manager;
    
    if (!wrapMgrAddr) {
      throw new Error(`No Autowrap Manager address found in metadata for network ${network.name}`);
    }
    
    wrapManager = await testBase.getContractAt(WrapManagerAbi, wrapMgrAddr);
    console.log(`Using Wrap Manager at: ${wrapMgrAddr}`);

    // set the env var "START_BLOCK" to the value of env var "TESTING_START_BLOCK"
    process.env.START_BLOCK = process.env.TESTING_START_BLOCK;
    console.log(`Set START_BLOCK to ${process.env.START_BLOCK}`);
  });

  it("should scan and identify wrap schedules correctly", async function() {
    // Get current state
    const currentTimestamp = await testBase.getCurrentTimestamp();
    console.log(`Current chain timestamp: ${currentTimestamp}`);

    console.log(`Set START_BLOCK to ${process.env.START_BLOCK}`);

    // Run the wrap schedule scanner
    await run(testBase.provider, impersonatedSigner, dataDir);

    // Verify that the state file was created/updated
    const stateFileName = path.join(dataDir, `wrapschedules_${network.name}.json`);
    expect(fs.existsSync(stateFileName)).to.be.true;

    const stateData = JSON.parse(fs.readFileSync(stateFileName, 'utf8'));
    expect(stateData).to.have.property('activeSchedules');
    expect(stateData).to.have.property('removedSchedules');
    expect(stateData).to.have.property('lastBlock');
    
    console.log(`Found ${stateData.activeSchedules.length} active schedules`);
    console.log(`Found ${stateData.removedSchedules.length} removed schedules`);
  });

  it("should execute due wrap schedules when conditions are met", async function() {
    // This test would require setting up specific wrap schedule conditions
    // For now, we'll just verify the execution logic can run without errors
    
    const currentTimestamp = await testBase.getCurrentTimestamp();
    console.log(`Current chain timestamp: ${currentTimestamp}`);

    // Run the wrap schedule execution
    await run(testBase.provider, impersonatedSigner, dataDir);
    
    // In a real test, you would:
    // 1. Create a wrap schedule with specific conditions
    // 2. Fast forward time to make it executable
    // 3. Verify the execution happened correctly
    // 4. Check the resulting state changes
  });

  after(async function() {
    // Clean up impersonated account
    if (impersonatedSigner) {
      await testBase.stopImpersonating(await impersonatedSigner.getAddress());
    }
    
    // // Clean up test data directory
    // if (fs.existsSync(dataDir)) {
    //   fs.rmSync(dataDir, { recursive: true, force: true });
    // }
  });
}); 