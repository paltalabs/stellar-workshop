/**
 * DeFindex Workshop - Direct Contract Calls
 * 
 * This file demonstrates how to interact with DeFindex contracts directly
 * using the Stellar SDK, without relying on the DeFindex SDK or API.
 * 
 * Key differences from defindex.ts:
 * - All transactions are built directly using Stellar SDK
 * - No DeFindex SDK or API calls
 * - Direct contract invocations using Contract.call()
 * - Manual parameter conversion to ScVal format
 * - Manual transaction building, simulation, and signing
 * 
 * This provides a deeper understanding of how the contracts work at the
 * lowest level and gives full control over transaction construction.
 * 
 * Requirements:
 * - Set DEFINDEX_FACTORY environment variable to your deployed factory address
 *   Example: DEFINDEX_FACTORY=CC... node defindex-typescript.ts
 */

import {
  Keypair,
  Networks,
  Horizon,
  rpc,
  Contract,
  Address,
  scValToNative,
  nativeToScVal,
  TransactionBuilder,
  Account,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "dotenv";
config();

// ========================================
// CONSTANTS
// ========================================
const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const TESTNET_SOROBAN_URL = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = Networks.TESTNET;

// Contract addresses (Testnet)
const SOROSWAP_ROUTER = "CCMAPXWVZD4USEKDWRYS7DA4Y3D7E2SDMGBFJUCEXTC7VN6CUBGWPFUS";
// DeFindex Factory address - replace with your deployed factory address
// You can deploy one using the deploy scripts or use an existing one
// Example: const DEFINDEX_FACTORY = process.env.DEFINDEX_FACTORY || "YOUR_FACTORY_ADDRESS_HERE";
const DEFINDEX_FACTORY = process.env.DEFINDEX_FACTORY || "YOUR_FACTORY_ADDRESS_HERE";

// ========================================
// SERVER INITIALIZATION
// ========================================
const horizonServer = new Horizon.Server(TESTNET_HORIZON_URL);
const sorobanServer = new rpc.Server(TESTNET_SOROBAN_URL);

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Create a transaction builder for a given account
 */
async function createTxBuilder(source: Keypair): Promise<TransactionBuilder> {
  try {
    const account: Account = await sorobanServer.getAccount(source.publicKey());
    return new TransactionBuilder(account, {
      fee: "10000",
      timebounds: { minTime: 0, maxTime: 0 },
      networkPassphrase: TESTNET_PASSPHRASE,
    });
  } catch (e: any) {
    console.error(e);
    throw Error("unable to create txBuilder");
  }
}

/**
 * Invoke a smart contract method directly
 */
async function invokeContract(
  contractId: string,
  method: string,
  params: xdr.ScVal[],
  source: Keypair,
  sim: boolean = false
): Promise<any> {
  console.log(`Invoking contract ${contractId} method: ${method}`);
  
  const contractInstance = new Contract(contractId);
  const contractOperation = contractInstance.call(method, ...params);
  
  const txBuilder = await createTxBuilder(source);
  txBuilder.addOperation(contractOperation);
  const tx = txBuilder.build();
  
  // Simulate the transaction
  const simulation_resp = await sorobanServer.simulateTransaction(tx);
  
  if (rpc.Api.isSimulationError(simulation_resp)) {
    console.log("simulation_resp error", simulation_resp.error);
    throw Error(simulation_resp.error);
  } else if (sim) {
    // Only simulate, return simulation result
    return simulation_resp;
  }

  // Assemble and sign the transaction
  const txResources = simulation_resp.transactionData.build().resources();
  simulation_resp.minResourceFee = (
    Number(simulation_resp.minResourceFee) + 10000000
  ).toString();
  
  const sim_tx_data = simulation_resp.transactionData
    .setResources(
      txResources.instructions() == 0 ? 0 : txResources.instructions() + 500000,
      txResources.diskReadBytes(),
      txResources.writeBytes()
    )
    .build();
  
  const assemble_tx = rpc.assembleTransaction(tx, simulation_resp);
  sim_tx_data.resourceFee(
    xdr.Int64.fromString(
      (Number(sim_tx_data.resourceFee().toString()) + 100000).toString()
    )
  );
  
  const prepped_tx = assemble_tx.setSorobanData(sim_tx_data).build();
  prepped_tx.sign(source);
  const tx_hash = prepped_tx.hash().toString("hex");
  
  console.log("submitting tx...");
  let response = await sorobanServer.sendTransaction(prepped_tx);
  let status = response.status;
  console.log(`Hash: ${tx_hash}`);
  
  // Poll until transaction is confirmed
  while (status === "PENDING" || status === "NOT_FOUND") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("checking tx...");
    response = await sorobanServer.getTransaction(tx_hash);
    status = response.status;
  }
  
  return response;
}

/**
 * Get token balance for a wallet using contract simulation
 */
async function getTokenBalance(contractId: string, walletAddress: string): Promise<bigint> {
  try {
    const contract = new Contract(contractId);
    const operation = contract.call("balance", new Address(walletAddress).toScVal());

    const account = await sorobanServer.getAccount(walletAddress);
    const transaction = new TransactionBuilder(account, {
      fee: "2000",
      networkPassphrase: TESTNET_PASSPHRASE
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const simulated = await sorobanServer.simulateTransaction(transaction);
    const balance = scValToNative((simulated as any).result.retval);

    return BigInt(balance);
  } catch (error) {
    console.log(`⚠️  Failed to get balance for contract ${contractId}:`, error);
    return BigInt(0);
  }
}

/**
 * Build roles map for vault creation
 */
function buildRolesMap(
  emergencyManager: string,
  feeReceiver: string,
  manager: string,
  rebalanceManager: string
): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvU32(0),
      val: new Address(emergencyManager).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvU32(1),
      val: new Address(feeReceiver).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvU32(2),
      val: new Address(manager).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvU32(3),
      val: new Address(rebalanceManager).toScVal(),
    }),
  ]);
}

/**
 * Build assets array for vault creation
 */
function buildAssetsArray(assets: Array<{
  address: string;
  strategies: Array<{
    address: string;
    name: string;
    paused: boolean;
  }>;
}>): xdr.ScVal {
  return xdr.ScVal.scvVec(
    assets.map((asset) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("address"),
          val: new Address(asset.address).toScVal(),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("strategies"),
          val: xdr.ScVal.scvVec(
            asset.strategies.map((strategy) =>
              xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("address"),
                  val: new Address(strategy.address).toScVal(),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("name"),
                  val: nativeToScVal(strategy.name, { type: "string" }),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("paused"),
                  val: nativeToScVal(strategy.paused, { type: "bool" }),
                }),
              ])
            )
          ),
        }),
      ])
    )
  );
}

/**
 * Build name_symbol map for vault creation
 */
function buildNameSymbolMap(name: string, symbol: string): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvString("name"),
      val: nativeToScVal(name, { type: "string" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvString("symbol"),
      val: nativeToScVal(symbol, { type: "string" }),
    }),
  ]);
}

/**
 * Create a DeFindex vault using the factory contract
 */
async function createVault(
  factoryAddress: string,
  roles: {
    emergencyManager: string;
    feeReceiver: string;
    manager: string;
    rebalanceManager: string;
  },
  vaultFeeBps: number,
  assets: Array<{
    address: string;
    strategies: Array<{
      address: string;
      name: string;
      paused: boolean;
    }>;
  }>,
  routerAddress: string,
  vaultName: string,
  vaultSymbol: string,
  upgradable: boolean,
  creator: Keypair
): Promise<string> {
  console.log("\n🏗️  Creating vault via factory contract...");

  const rolesMap = buildRolesMap(
    roles.emergencyManager,
    roles.feeReceiver,
    roles.manager,
    roles.rebalanceManager
  );

  const assetsArray = buildAssetsArray(assets);
  const nameSymbolMap = buildNameSymbolMap(vaultName, vaultSymbol);

  // Parameters for create_defindex_vault:
  // (roles: Map<u32, Address>, vault_fee: u32, assets: Vec<AssetStrategySet>, 
  //  soroswap_router: Address, name_symbol: Map<String, String>, upgradable: bool)
  const createVaultParams: xdr.ScVal[] = [
    rolesMap,                                           // roles
    nativeToScVal(vaultFeeBps, { type: "u32" }),      // vault_fee (in basis points)
    assetsArray,                                        // assets
    new Address(routerAddress).toScVal(),              // soroswap_router
    nameSymbolMap,                                      // name_symbol
    nativeToScVal(upgradable, { type: "bool" }),      // upgradable
  ];

  console.log("🔨 Building vault creation transaction...");
  const result = await invokeContract(
    factoryAddress,
    "create_defindex_vault",
    createVaultParams,
    creator,
    false
  );

  // Extract vault contract address from return value
  const vaultAddress = scValToNative(result.returnValue);
  console.log(`✅ Vault created successfully!`);
  console.log(`📋 Vault Contract Address: ${vaultAddress}`);
  
  return vaultAddress.toString();
}

/**
 * Deposit to a DeFindex vault
 */
async function depositToVault(
  vaultAddress: string,
  amounts: bigint[],
  depositor: Keypair,
  invest: boolean = false,
  slippageBps: number = 500
): Promise<any> {
  console.log("\n💸 Depositing to vault...");

  // Calculate minimum amounts with slippage
  const amountsMin = amounts.map((amount) => 
    (amount * BigInt(10000 - slippageBps)) / BigInt(10000)
  );

  // Parameters for deposit:
  // (amounts_desired: Vec<i128>, amounts_min: Vec<i128>, to: Address, invest: bool)
  const depositParams: xdr.ScVal[] = [
    xdr.ScVal.scvVec(
      amounts.map((amount) => nativeToScVal(amount, { type: "i128" }))
    ),                                                  // amounts_desired
    xdr.ScVal.scvVec(
      amountsMin.map((min) => nativeToScVal(min, { type: "i128" }))
    ),                                                  // amounts_min
    new Address(depositor.publicKey()).toScVal(),      // to (recipient of vault shares)
    nativeToScVal(invest, { type: "bool" }),          // invest (immediately invest into strategies)
  ];

  console.log("🔨 Building deposit transaction...");
  const result = await invokeContract(
    vaultAddress,
    "deposit",
    depositParams,
    depositor,
    false
  );

  console.log("✅ Deposit completed successfully!");
  const depositResult = scValToNative(result.returnValue);
  console.log("📊 Deposit Response:", depositResult);
  
  return depositResult;
}

/**
 * Get vault share token balance for a user
 */
async function getVaultBalance(vaultAddress: string, userAddress: string): Promise<bigint> {
  try {
    return await getTokenBalance(vaultAddress, userAddress);
  } catch (error) {
    console.error(`Failed to get vault balance for ${userAddress}:`, error);
    return BigInt(0);
  }
}

// ========================================
// MAIN WORKSHOP FUNCTION
// ========================================

/**
 * DeFindex Workshop: Demonstrates vault creation and deposit flows using direct contract calls
 *
 * Flow:
 * 1. Create vault manager wallet and fund it
 * 2. Configure and create a new DeFindex vault
 * 3. Make initial deposit to the vault
 * 4. Create a separate depositor wallet
 * 5. Make an additional deposit to the vault from the depositor
 */
async function defindexWorkshop() {
  console.log("🚀 Starting DeFindex Workshop (Direct Contract Calls)!");
  console.log("=".repeat(70));

  try {
    // ========================================
    // STEP 1: CREATE VAULT MANAGER WALLET
    // ========================================
    console.log("\n📝 STEP 1: Creating Vault Manager Wallet");
    console.log("=".repeat(40));

    const keyPair = Keypair.random();
    console.log("🏛️  Vault Manager wallet created:");
    console.log(`   Public Key: ${keyPair.publicKey()}`);
    console.log(`   Secret Key: ${keyPair.secret()}`);

    // Fund the vault manager wallet via Soroban airdrop
    console.log("\n💰 Requesting airdrop for vault manager...");
    await sorobanServer.requestAirdrop(keyPair.publicKey());
    console.log("✅ Vault manager funded successfully");

    // ========================================
    // STEP 2: CONFIGURE VAULT
    // ========================================
    console.log("\n⚙️  STEP 2: Configuring Vault Parameters");
    console.log("=".repeat(40));

    /**
     * Vault Configuration:
     * - Roles: Define who can manage different aspects of the vault
     *   - 0: Emergency Manager (can pause vault in emergencies)
     *   - 1: Fee Receiver (receives vault management fees)
     *   - 2: Manager (general vault management)
     *   - 3: Rebalance Manager (can rebalance assets across strategies)
     * - vault_fee_bps: Fee in basis points (2000 = 20%)
     * - assets: Assets the vault will manage and their strategies
     * - soroswap_router: Router contract for swaps
     * - name_symbol: Vault name and share token symbol
     * - upgradable: Whether vault contract can be upgraded
     */
    const vaultConfig = {
      roles: {
        emergencyManager: keyPair.publicKey(),
        feeReceiver: keyPair.publicKey(),
        manager: keyPair.publicKey(),
        rebalanceManager: keyPair.publicKey(),
      },
      vault_fee_bps: 2000, // 20% management fee (2000 basis points)
      assets: [{
        address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // Asset contract
        strategies: [{
          address: "CCSPRGGUP32M23CTU7RUAGXDNOHSA6O2BS2IK4NVUP5X2JQXKTSIQJKE", // Strategy contract
          name: "XLM Strategy",
          paused: false // Strategy is active
        }]
      }],
      soroswap_router: SOROSWAP_ROUTER,
      name_symbol: { name: "TestVault", symbol: "TV" },
      upgradable: true,
    };

    console.log("📋 Vault Configuration:");
    console.log(`   Name: ${vaultConfig.name_symbol.name}`);
    console.log(`   Symbol: ${vaultConfig.name_symbol.symbol}`);
    console.log(`   Fee: ${vaultConfig.vault_fee_bps / 100}%`);
    console.log(`   Manager: ${keyPair.publicKey()}`);
    console.log(`   Assets: ${vaultConfig.assets.length}`);

    // Check if factory address is configured
    if (!DEFINDEX_FACTORY || DEFINDEX_FACTORY === "YOUR_FACTORY_ADDRESS_HERE") {
      console.log("\n⚠️  WARNING: Factory address not set!");
      console.log("   Please set DEFINDEX_FACTORY environment variable or constant");
      console.log("   You can deploy one using the deploy scripts or use an existing one");
      console.log("   Example: DEFINDEX_FACTORY=CC... node defindex-typescript.ts");
      throw new Error("Factory address not configured. Please set DEFINDEX_FACTORY environment variable.");
    }

    // ========================================
    // STEP 3: CREATE VAULT
    // ========================================
    console.log("\n🏗️  STEP 3: Creating Vault");
    console.log("=".repeat(40));

    const vaultContract = await createVault(
      DEFINDEX_FACTORY,
      vaultConfig.roles,
      vaultConfig.vault_fee_bps,
      vaultConfig.assets,
      vaultConfig.soroswap_router,
      vaultConfig.name_symbol.name,
      vaultConfig.name_symbol.symbol,
      vaultConfig.upgradable,
      keyPair
    );

    console.log(`🎉 Vault created successfully!`);
    console.log(`📋 Vault Contract Address: ${vaultContract}`);

    // ========================================
    // STEP 4: MAKE INITIAL DEPOSIT
    // ========================================
    console.log("\n💸 STEP 4: Making Initial Deposit to Vault");
    console.log("=".repeat(40));

    const initialDepositAmount = BigInt(100000000); // 100 tokens with 7 decimals
    console.log(`📊 Deposit details:`);
    console.log(`   Depositor: ${keyPair.publicKey()}`);
    console.log(`   Amount: ${Number(initialDepositAmount) / 10000000} tokens`);
    console.log(`   Slippage tolerance: 5%`);
    console.log(`   Invest immediately: No (keep as idle)`);

    await depositToVault(
      vaultContract,
      [initialDepositAmount],
      keyPair,
      false,  // Don't invest into strategies, keep as idle
      500     // 5% slippage tolerance
    );

    // Check vault balance after deposit
    const vaultBalanceAfterDeposit = await getVaultBalance(vaultContract, keyPair.publicKey());
    console.log(`\n💰 Vault share balance: ${Number(vaultBalanceAfterDeposit) / 10000000} tokens`);

    // ========================================
    // STEP 5: CREATE DEPOSITOR WALLET
    // ========================================
    console.log("\n👤 STEP 5: Creating Additional Depositor");
    console.log("=".repeat(40));

    // Create a new wallet to demonstrate external deposits
    const depositor = Keypair.random();
    console.log("🏦 Depositor wallet created:");
    console.log(`   Public Key: ${depositor.publicKey()}`);
    console.log(`   Secret Key: ${depositor.secret()}`);

    console.log("\n💰 Requesting airdrop for depositor...");
    await sorobanServer.requestAirdrop(depositor.publicKey());
    console.log("✅ Depositor funded successfully");

    // ========================================
    // STEP 6: DEPOSIT TO VAULT
    // ========================================
    console.log("\n💸 STEP 6: Making Deposit to Vault");
    console.log("=".repeat(40));

    const depositAmount = BigInt(10000000000); // 1000 tokens with 7 decimals
    console.log(`📊 Deposit details:`);
    console.log(`   Depositor: ${depositor.publicKey()}`);
    console.log(`   Amount: ${Number(depositAmount) / 10000000} tokens`);
    console.log(`   Slippage tolerance: 5%`);
    console.log(`   Invest immediately: No (keep as idle)`);

    await depositToVault(
      vaultContract,
      [depositAmount],
      depositor,
      false,  // Don't invest into strategies, keep as idle
      500     // 5% slippage tolerance
    );

    // Check vault balance after deposit
    const vaultBalanceAfterSecondDeposit = await getVaultBalance(vaultContract, depositor.publicKey());
    console.log(`\n💰 Depositor vault share balance: ${Number(vaultBalanceAfterSecondDeposit) / 10000000} tokens`);

    // ========================================
    // FINAL SUMMARY
    // ========================================
    console.log("\n" + "=".repeat(70));
    console.log("🎓 Workshop Summary");
    console.log("=".repeat(70));
    console.log("\n✨ What we accomplished:");
    console.log("   1. ✅ Created vault manager wallet");
    console.log("   2. ✅ Configured vault with roles and strategies");
    console.log(`   3. ✅ Created vault: ${vaultContract}`);
    console.log(`   4. ✅ Made initial deposit: ${Number(initialDepositAmount) / 10000000} tokens`);
    console.log("   5. ✅ Created depositor wallet");
    console.log(`   6. ✅ Made additional deposit: ${Number(depositAmount) / 10000000} tokens`);

    console.log("\n🔗 Important Addresses:");
    console.log(`   Vault Contract: ${vaultContract}`);
    console.log(`   Vault Manager: ${keyPair.publicKey()}`);
    console.log(`   Depositor: ${depositor.publicKey()}`);

    console.log("\n🌟 Key Learning Points:");
    console.log("   • DeFindex vaults manage multiple assets with configurable strategies");
    console.log("   • Roles define granular permissions (emergency, fees, management, rebalancing)");
    console.log("   • Vaults are created via factory contract");
    console.log("   • External users can deposit into existing vaults");
    console.log("   • Deposits can be kept idle or immediately invested into strategies");
    console.log("\n💡 Key Differences from SDK:");
    console.log("   • All transactions built directly using Stellar SDK");
    console.log("   • No DeFindex SDK or API calls");
    console.log("   • Direct contract invocations using Contract.call()");
    console.log("   • Manual parameter conversion to ScVal format");
    console.log("   • Manual transaction building, simulation, and signing");

    console.log("\n🚀 Workshop completed successfully!");

  } catch (error) {
    console.error("\n❌ Workshop Error:", error);
    if (error instanceof Error) {
      console.error("🔍 Error message:", error.message);
      if ('response' in error) {
        const errorWithResponse = error as any;
        if (errorWithResponse.response?.data) {
          console.error("🔍 Error details:", errorWithResponse.response.data);
        }
      }
    }
  }
}

// Execute the workshop
defindexWorkshop();

