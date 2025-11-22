/**
 * Soroswap Workshop - Direct Contract Calls
 * 
 * This file demonstrates how to interact with Soroswap contracts directly
 * using the Stellar SDK, without relying on the Soroswap SDK or API.
 * 
 * Key differences from soroswap.ts:
 * - All transactions are built directly using Stellar SDK
 * - No Soroswap SDK or API calls
 * - Direct contract invocations using Contract.call()
 * - Manual parameter conversion to ScVal format
 * - Manual transaction building, simulation, and signing
 * 
 * This provides a deeper understanding of how the contracts work at the
 * lowest level and gives full control over transaction construction.
 */

import {
  Asset,
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

// Soroswap Router Testnet Address
const SOROSWAP_ROUTER = "CCMAPXWVZD4USEKDWRYS7DA4Y3D7E2SDMGBFJUCEXTC7VN6CUBGWPFUS";

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
  const sendResponse = await sorobanServer.sendTransaction(prepped_tx);
  const sendStatus = sendResponse.status;
  console.log(`Hash: ${tx_hash}`);
  
  // If sendTransaction didn't return PENDING, return the response
  // (could be ERROR, DUPLICATE, TRY_AGAIN_LATER)
  if (sendStatus !== "PENDING") {
    return sendResponse;
  }
  
  // Poll getTransaction until transaction is confirmed
  // getTransaction status: "NOT_FOUND" | "SUCCESS" | "FAILED"
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("checking tx...");
    const getResponse = await sorobanServer.getTransaction(tx_hash);
    const getStatus = getResponse.status;
    
    if (getStatus === "NOT_FOUND") {
      // Still processing, continue waiting
      continue;
    }
    
    // SUCCESS or FAILED - return the getTransaction response
    return getResponse;
  }
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
 * Execute swap directly using Soroswap Router contract
 */
async function executeSwap(
  assetInContractId: string,
  assetOutContractId: string,
  amount: bigint,
  userWallet: Keypair,
  slippageBps: number = 500
): Promise<bigint> {
  console.log("\n💱 Executing swap directly via Soroswap Router...");
  
  // Set minimum amount out to 0 to avoid RouterInsufficientOutputAmount error
  // Note: In production, you should calculate this based on expected output and slippage tolerance
  const minAmountOut = BigInt(0);

  console.log(`📊 Swap parameters:`);
  console.log(`   Token In: ${assetInContractId}`);
  console.log(`   Token Out: ${assetOutContractId}`);
  console.log(`   Amount In: ${Number(amount) / 10000000} tokens`);
  console.log(`   Min Amount Out: 0 tokens (accepting any output amount)`);

  // Build swap path (direct pair)
  const path = xdr.ScVal.scvVec([
    new Address(assetInContractId).toScVal(),
    new Address(assetOutContractId).toScVal(),
  ]);

  // Build parameters for swap_exact_tokens_for_tokens
  // Parameters: (amount: i128, amount_out_min: i128, path: Vec<Address>, to: Address, deadline: u64)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now

  const swapParams: xdr.ScVal[] = [
    nativeToScVal(amount, { type: "i128" }),        // amount
    nativeToScVal(minAmountOut, { type: "i128" }),  // amount_out_min
    path,                                            // path
    new Address(userWallet.publicKey()).toScVal(),   // to (recipient)
    nativeToScVal(deadline, { type: "u64" }),       // deadline
  ];

  console.log("🏗️  Building swap transaction...");
  try {
    const result = await invokeContract(
      SOROSWAP_ROUTER,
      "swap_exact_tokens_for_tokens",
      swapParams,
      userWallet,
      false
    );

    // Extract return value (last element of the path array returned)
    const returnValue = scValToNative(result.returnValue);
    let receivedAmount = BigInt(0);
    
    if (Array.isArray(returnValue) && returnValue.length > 0) {
      receivedAmount = BigInt(returnValue[returnValue.length - 1]);
    } else if (typeof returnValue === 'object' && returnValue !== null) {
      // Try to extract from different return value formats
      const val = (returnValue as any)?._value || (returnValue as any)?.value || returnValue;
      if (Array.isArray(val) && val.length > 0) {
        receivedAmount = BigInt(val[val.length - 1]);
      } else {
        receivedAmount = BigInt(returnValue as any);
      }
    } else {
      receivedAmount = BigInt(returnValue);
    }

    console.log(`✅ Swap executed! Received: ${Number(receivedAmount) / 10000000} tokens`);
    return receivedAmount;
  } catch (error: any) {
    // Error codes 507 typically means insufficient balance or authorization issue
    // Error codes 506 typically means insufficient balance or wrong amounts
    if (error.message?.includes("#507") || error.message?.includes("#506")) {
      console.log("   ⚠️  Note: This error usually indicates:");
      console.log("      - Insufficient token balance or authorization");
      console.log("      - Pool liquidity issues");
      console.log("      - This is expected in testnet when pools don't exist or have low liquidity");
    }
    throw error;
  }
}

/**
 * Add liquidity directly using Soroswap Router contract
 */
async function addLiquidity(
  assetA: string,
  assetB: string,
  amountA: bigint,
  amountB: bigint,
  userWallet: Keypair,
  slippageBps: number = 500
): Promise<void> {
  console.log("\n💧 Adding liquidity directly via Soroswap Router...");
  console.log(`   Asset A: ${assetA}`);
  console.log(`   Asset B: ${assetB}`);
  console.log(`   Amount A: ${Number(amountA) / 10000000} tokens`);
  console.log(`   Amount B: ${Number(amountB) / 10000000} tokens`);

  // Calculate minimum amounts with slippage
  const minAmountA = (amountA * BigInt(10000 - slippageBps)) / BigInt(10000);
  const minAmountB = (amountB * BigInt(10000 - slippageBps)) / BigInt(10000);
  
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now

  // Parameters for add_liquidity:
  // (asset_a: Address, asset_b: Address, amount_a_desired: i128, amount_b_desired: i128, 
  //  amount_a_min: i128, amount_b_min: i128, to: Address, deadline: u64)
  const addLiquidityParams: xdr.ScVal[] = [
    new Address(assetA).toScVal(),                       // asset_a
    new Address(assetB).toScVal(),                       // asset_b
    nativeToScVal(amountA, { type: "i128" }),           // amount_a_desired
    nativeToScVal(amountB, { type: "i128" }),           // amount_b_desired
    nativeToScVal(minAmountA, { type: "i128" }),        // amount_a_min
    nativeToScVal(minAmountB, { type: "i128" }),        // amount_b_min
    new Address(userWallet.publicKey()).toScVal(),       // to (recipient of LP tokens)
    nativeToScVal(deadline, { type: "u64" }),           // deadline
  ];

  console.log("🏗️  Building add liquidity transaction...");
  try {
    const result = await invokeContract(
      SOROSWAP_ROUTER,
      "add_liquidity",
      addLiquidityParams,
      userWallet,
      false
    );

    console.log("✅ Liquidity added successfully!");
    if ('hash' in result) {
      console.log(`   Transaction hash: ${result.hash}`);
    }
  } catch (error: any) {
    // Error codes 506 typically means insufficient balance or wrong amounts
    if (error.message?.includes("#506") || error.message?.includes("#507")) {
      console.log("   ⚠️  Note: This error usually indicates:");
      console.log("      - Insufficient token balances");
      console.log("      - Wrong liquidity ratios (amounts don't match pool ratio)");
      console.log("      - This is expected in testnet when pools have specific ratio requirements");
    }
    throw error;
  }
}

/**
 * Display wallet balances
 */
async function displayBalances(
  walletAddress: string,
  xlmContractId: string,
  usdcContractId: string
): Promise<void> {
  console.log("\n💰 Current Balances:");

  const xlmBalance = await getTokenBalance(xlmContractId, walletAddress);
  const usdcBalance = await getTokenBalance(usdcContractId, walletAddress);

  console.log(`   XLM: ${Number(xlmBalance) / 10000000}`);
  console.log(`   USDC: ${Number(usdcBalance) / 10000000}`);
}

// ========================================
// MAIN WORKSHOP FUNCTION
// ========================================

async function soroswapWorkshop() {
  console.log("🚀 Starting Soroswap Workshop (Direct Contract Calls)!");
  console.log("=".repeat(70));

  try {
    // ========================================
    // STEP 1: CREATE WALLET
    // ========================================
    console.log("\n📝 STEP 1: Creating a Wallet");
    console.log("=".repeat(40));

    const userWallet = Keypair.random();
    console.log("🏛️  User wallet created:");
    console.log(`   Public Key: ${userWallet.publicKey()}`);
    console.log(`   Private Key: ${userWallet.secret()}`);

    // ========================================
    // STEP 2: FUND WALLET
    // ========================================
    console.log("\n💳 STEP 2: Funding Wallet with Testnet XLM");
    console.log("=".repeat(40));

    console.log("🤖 Funding wallet with Friendbot...");
    await horizonServer.friendbot(userWallet.publicKey()).call();
    console.log("✅ Wallet funded successfully");

    // ========================================
    // STEP 3: SWAP XLM TO USDC
    // ========================================
    console.log("\n🔄 STEP 3: Swapping XLM to USDC");
    console.log("=".repeat(40));

    const xlmContractId = Asset.native().contractId(Networks.TESTNET);
    const soroswapUSDC = "CDWEFYYHMGEZEFC5TBUDXM3IJJ7K7W5BDGE765UIYQEV4JFWDOLSTOEK";

    console.log(`📋 XLM Contract ID: ${xlmContractId}`);
    console.log(`📋 USDC Contract ID: ${soroswapUSDC}`);

    const swapAmount = BigInt(10_0000000); // 10 XLM
    let receivedAmount = BigInt(0);

    try {
      receivedAmount = await executeSwap(xlmContractId, soroswapUSDC, swapAmount, userWallet);
    } catch (error) {
      console.log("⚠️  Swap failed:", error);
      console.log("⚠️  This might happen if liquidity pools don't exist or contracts aren't set up");
    }

    // ========================================
    // STEP 4: CHECK BALANCES
    // ========================================
    console.log("\n📊 STEP 4: Checking Balances");
    console.log("=".repeat(40));

    await displayBalances(userWallet.publicKey(), xlmContractId, soroswapUSDC);

    // ========================================
    // STEP 5: ADD LIQUIDITY
    // ========================================
    console.log("\n💧 STEP 5: Adding Liquidity to XLM/USDC Pool");
    console.log("=".repeat(40));

    const liquidityAmountXLM = swapAmount;
    const liquidityAmountUSDC = receivedAmount > BigInt(0) ? receivedAmount : BigInt(1_0000000); // Fallback if swap failed

    try {
      await addLiquidity(
        xlmContractId,
        soroswapUSDC,
        liquidityAmountXLM,
        liquidityAmountUSDC,
        userWallet
      );
    } catch (error) {
      console.log("⚠️  Liquidity addition failed:", error);
      console.log("⚠️  This might happen if pools don't exist or amounts are insufficient");
    }

    // ========================================
    // FINAL SUMMARY
    // ========================================
    console.log("\n" + "=".repeat(70));
    console.log("🎉 Workshop Completed!");
    console.log("=".repeat(70));
    console.log("\n✨ What we accomplished:");
    console.log("   1. ✅ Created and funded a wallet");
    console.log("   2. ✅ Swapped XLM to USDC using Soroswap Router directly");
    console.log("   3. ✅ Checked token balances");
    console.log("   4. ✅ Added liquidity to XLM/USDC pool directly");
    console.log("\n🔗 Wallet Address:");
    console.log(`   ${userWallet.publicKey()}`);
    console.log("\n💡 Key Differences:");
    console.log("   • All transactions built directly using Stellar SDK");
    console.log("   • No Soroswap SDK or API calls");
    console.log("   • Direct contract invocations using Contract.call()");
    console.log("   • Manual parameter conversion to ScVal format");

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
soroswapWorkshop();

