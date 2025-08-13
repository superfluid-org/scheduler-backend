import { ethers } from "hardhat";
import { Signer } from "ethers";

export class TestBase {
  protected provider: any;
  protected impersonatedSigner: Signer;
  protected network: any;

  constructor() {
    this.provider = ethers.provider;
  }

  /**
   * Impersonate a funded account for testing
   */
  async impersonateAccount(address: string, balance?: string): Promise<Signer> {
    await this.provider.send("hardhat_impersonateAccount", [address]);
    const signer = await ethers.getSigner(address);
    
    if (balance) {
      await this.provider.send("hardhat_setBalance", [
        address,
        balance || "0x56BC75E2D63100000", // 100 ETH default
      ]);
    }
    
    return signer;
  }

  /**
   * Fast forward time by mining blocks with specific timestamps
   */
  async fastForwardTime(timestamp: number): Promise<void> {
    await this.provider.send("evm_setNextBlockTimestamp", [timestamp]);
    await this.provider.send("evm_mine");
  }

  /**
   * Get current block timestamp
   */
  async getCurrentTimestamp(): Promise<number> {
    const block = await this.provider.getBlock("latest");
    return block.timestamp;
  }

  /**
   * Stop impersonating an account
   */
  async stopImpersonating(address: string): Promise<void> {
    await this.provider.send("hardhat_stopImpersonatingAccount", [address]);
  }

  /**
   * Get a contract instance at a specific address
   */
  async getContractAt(abi: any, address: string): Promise<any> {
    return ethers.getContractAt(abi, address);
  }
} 