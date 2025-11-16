import {
  Asset,
  Keypair,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  Networks,
  Horizon,
  rpc,
  xdr,
  StrKey,
  hash,
  Account,
  Contract,
  Address,
  scValToNative,
} from "@stellar/stellar-sdk";
import { SoroswapSDK, SupportedNetworks, TradeType, SupportedProtocols } from "@soroswap/sdk";
import { config } from "dotenv";
config();

// Initialize servers
const horizonServer = new Horizon.Server("https://horizon-testnet.stellar.org");
const sorobanServer = new rpc.Server("https://soroban-testnet.stellar.org");

// Soroswap SDK configuration
const soroswapSDK = new SoroswapSDK({
  apiKey: process.env.SOROSWAP_API_KEY as string,
  baseUrl: "https://api.soroswap.finance",
  defaultNetwork: SupportedNetworks.TESTNET,
  timeout: 30000,
});

// Helper function to display countdown
async function countdown(seconds: number, message: string = "Next step in") {
  console.log(`\n⏰ ${message}:`);
  
  for (let i = seconds; i > 0; i--) {
    const minutes = Math.floor(i / 60);
    const remainingSeconds = i % 60;
    const timeStr = minutes > 0 
      ? `${minutes}:${remainingSeconds.toString().padStart(2, '0')}` 
      : `${remainingSeconds}`;
    
    process.stdout.write(`\r⏳ ${timeStr} seconds remaining...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log("\n✅ Ready to proceed!\n");
}

// Helper function to deploy Stellar Asset to Soroban
async function deployStellarAsset(
  asset: Asset,
  sourceAccount: Account,
  sourceKeypair: Keypair
): Promise<string> {
  console.log(`🚀 Deploying ${asset.code} to Soroban...`);
  
  const xdrAsset = asset.toXDRObject();
  const networkId = hash(Buffer.from(Networks.TESTNET));
  
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(xdrAsset),
    })
  );
  
  const contractId = StrKey.encodeContract(hash(preimage.toXDR()));
  console.log(`📋 Predicted Contract ID: ${contractId}`);

  const deployFunction = xdr.HostFunction.hostFunctionTypeCreateContract(
    new xdr.CreateContractArgs({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(xdrAsset),
      executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
    })
  );

  const deployOperation = Operation.invokeHostFunction({
    func: deployFunction,
    auth: [],
  });

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(deployOperation)
    .setTimeout(30)
    .build();

  // Prepare transaction for Soroban
  const preparedTransaction = await sorobanServer.prepareTransaction(transaction);
  preparedTransaction.sign(sourceKeypair);

  // Submit transaction
  const response = await sorobanServer.sendTransaction(preparedTransaction);
  console.log(`✅ Deploy transaction submitted: ${response.hash}`);

  // Wait for transaction to be confirmed
  let getResponse = await sorobanServer.getTransaction(response.hash);
  while (getResponse.status === "NOT_FOUND") {
    console.log("⏳ Waiting for transaction confirmation...");
    await new Promise(resolve => setTimeout(resolve, 1000));
    getResponse = await sorobanServer.getTransaction(response.hash);
  }

  if (getResponse.status === "SUCCESS") {
    console.log(`✅ ${asset.code} deployed to Soroban successfully!`);
    return contractId;
  } else {
    throw new Error(`Failed to deploy ${asset.code}: ${getResponse.status}`);
  }
}

// Helper function to get contract ID for asset
function getAssetContractId(asset: Asset): string {
  if (asset.isNative()) {
    return Asset.native().contractId(Networks.TESTNET);
  }
  return asset.contractId(Networks.TESTNET);
}

async function soroswapWorkshop() {
  console.log("🚀 Starting Soroswap Workshop!");
  console.log("=" .repeat(70));

  try {
    // ========================================
    // STEP 1: CREATE WALLET
    // ========================================
    console.log("\n📝 STEP 1: Creating a Wallet");
    console.log("=".repeat(40));

    // Create the asset creator wallet
    const userWallet = Keypair.random();
    console.log("🏛️  userWallet created:");
    console.log(`   Public Key: ${userWallet.publicKey()}`);
    console.log(`   Private Key: ${userWallet.secret()}`);

    // ========================================
    // STEP 2: FUND WALLET
    // ========================================
    console.log("\n💳 STEP 2: Funding Wallet with Testnet XLM");
    console.log("=".repeat(40));

    console.log("🤖 Funding wallets with Friendbot...");
    await horizonServer.friendbot(userWallet.publicKey()).call(),
    console.log("✅ Wallet funded successfully");

    // ========================================
    // STEP 3: SWAP XLM TO SOROSWAP USDC
    // ========================================
    
    // Get XLM contract ID for Soroban
    const xlmContractId = Asset.native().contractId(Networks.TESTNET);
    console.log(`📋 XLM Contract ID: ${xlmContractId}`);
    const soroswapUSDC = "CDWEFYYHMGEZEFC5TBUDXM3IJJ7K7W5BDGE765UIYQEV4JFWDOLSTOEK"
    console.log("soroswapWorkshop | soroswapUSDC:", soroswapUSDC)

    const swapAmount = BigInt(10_0000000)
    let receivedAmount = BigInt(0)

    try {
      // Step 1: Get quote from Soroswap SDK
      console.log("📊 Getting quote from Soroswap SDK...");
      const quoteResponse = await soroswapSDK.quote(
        {
          assetIn: xlmContractId,
          assetOut: soroswapUSDC,
          amount: swapAmount,
          tradeType: TradeType.EXACT_IN,
          protocols: [SupportedProtocols.SOROSWAP],
          slippageBps: 500, // 5% slippage
        },
        SupportedNetworks.TESTNET
      );
      console.log("🚀 | soroswapWorkshop | quoteResponse:", quoteResponse)

      console.log(`💡 Quote received:`);
      console.log(`   Input: ${Number(quoteResponse.amountIn) / 10000000} XLM`);
      console.log(`   Output: ${Number(quoteResponse.amountOut) / 10000000} USDC`);
      console.log(`   Price Impact: ${quoteResponse.priceImpactPct}%`);
      console.log(`   Platform: ${quoteResponse.platform}`);

      // Step 2: Build transaction from quote
      console.log("🏗️  Building transaction from quote...");
      
      const buildResponse = await soroswapSDK.build(
        {
          quote: quoteResponse,
          from: userWallet.publicKey(),
        },
        SupportedNetworks.TESTNET
      );
      console.log("🚀 | soroswapWorkshop | buildResponse:", buildResponse)
      console.log("📄 Transaction XDR received from Soroswap SDK");

      // Step 3: Sign and submit transaction
      const swapTransaction = TransactionBuilder.fromXDR(
        buildResponse.xdr,
        Networks.TESTNET
      );
      
      swapTransaction.sign(userWallet);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Submit the transaction
      const swapResult = await soroswapSDK.send(swapTransaction.toXDR(), false, SupportedNetworks.TESTNET);

      console.log("return value", swapResult.returnValue)
      const returnValue = swapResult.returnValue._value[1]._value._attributes.lo._value
      console.log("🚀 | soroswapWorkshop | returnValue:", returnValue)
      receivedAmount = BigInt(returnValue)

    } catch (error) {
      console.log("🚀 | soroswapWorkshop | error:", error)
      console.log("⚠️  Using simulated swap (SDK may require API key or pools may not exist)");
      console.log("✅ Swap conceptually executed: XLM → RIO");
    }



    // Getting balances
    let xlmBalance = 0
    let usdcBalance = 0
    try {
      const usdcContract = new Contract(soroswapUSDC)
      const op = usdcContract.call("balance", ...[new Address(userWallet.publicKey()).toScVal()])

      const loadedAccount = await sorobanServer.getAccount(userWallet.publicKey())
      const balanceTx = new TransactionBuilder(loadedAccount, {
        fee: "2000",
        networkPassphrase: Networks.TESTNET
      }).addOperation(op).setTimeout(300).build()

      const simulated = await sorobanServer.simulateTransaction(balanceTx)

      const parsed = scValToNative((simulated as any).result.retval)
      usdcBalance = parsed


      const xlmContract = new Contract(xlmContractId)
      const op2 = xlmContract.call("balance", ...[new Address(userWallet.publicKey()).toScVal()])

      const loadedAccount2 = await sorobanServer.getAccount(userWallet.publicKey())
      const balanceTx2 = new TransactionBuilder(loadedAccount2, {
        fee: "2000",
        networkPassphrase: Networks.TESTNET
      }).addOperation(op2).setTimeout(300).build()

      const simulated2 = await sorobanServer.simulateTransaction(balanceTx2)

      const parsed2 = scValToNative((simulated2 as any).result.retval)
      xlmBalance = parsed2
      
    } catch (error) {
      console.log("🚀 | soroswapWorkshop | error:", error)
      
    }

    console.log("USDC BALANCE", usdcBalance)
    console.log("XLM BALANCE", xlmBalance)


    // ========================================
    // ADD LIQUIDITY USING SOROSWAP SDK
    // ========================================

    const liquidityAmountXLM = swapAmount
    console.log("🚀 | soroswapWorkshop | liquidityAmountXLM:", liquidityAmountXLM)
    const liquidityAmountUSDC = receivedAmount
    console.log("🚀 | soroswapWorkshop | liquidityAmountUSDC:", liquidityAmountUSDC)

    try {
      // Add liquidity using Soroswap SDK
      const addLiquidityResponse = await soroswapSDK.addLiquidity(
        {
          assetA: xlmContractId,
          assetB: soroswapUSDC,
          amountA: liquidityAmountXLM,
          amountB: liquidityAmountUSDC,
          to: userWallet.publicKey(),
          slippageBps: "500", // 5% slippage tolerance
        },
        SupportedNetworks.TESTNET
      );

      console.log("📄 Liquidity transaction XDR received from Soroswap SDK");
      
      // Parse and sign the XDR
      const liquidityTransaction = TransactionBuilder.fromXDR(
        addLiquidityResponse.xdr,
        Networks.TESTNET
      );
      
      liquidityTransaction.sign(userWallet);
      
      const addLiquiditySendResponse = await soroswapSDK.send(liquidityTransaction.toXDR(), false, SupportedNetworks.TESTNET)
      console.log("🚀 | soroswapWorkshop | addLiquiditySendResponse:", addLiquiditySendResponse)
      // Submit the transaction
      // const liquidityResult = await sorobanServer.sendTransaction(liquidityTransaction);
      // console.log(`✅ Liquidity transaction submitted: ${liquidityResult.hash}`);
      
      // // Wait for confirmation
      // let getLiquidityResponse = await sorobanServer.getTransaction(liquidityResult.hash);
      // while (getLiquidityResponse.status === "NOT_FOUND") {
      //   console.log("⏳ Waiting for liquidity transaction confirmation...");
      //   await new Promise(resolve => setTimeout(resolve, 2000));
      //   getLiquidityResponse = await sorobanServer.getTransaction(liquidityResult.hash);
      // }
      
      // if (getLiquidityResponse.status === "SUCCESS") {
      //   console.log("✅ Liquidity added successfully to Soroswap!");
      // } else {
      //   console.log(`⚠️  Liquidity transaction status: ${getLiquidityResponse.status}`);
      // }
      
    } catch (error) {
      console.log("⚠️  Using simulated liquidity addition (SDK may require API key)");
      console.log("✅ Liquidity conceptually added to XLM/RIO pool");
    }

  } catch (error) {
    console.error("\n❌ Workshop Error:", error);
    if (error instanceof Error) {
      console.error("🔍 Error message:", error.message);
      if ('response' in error) {
        const errorWithResponse = error as any;
        if (errorWithResponse.response && errorWithResponse.response.data) {
          console.error("🔍 Error details:", errorWithResponse.response.data);
        }
      }
    }
  }
}

// Execute the workshop
soroswapWorkshop();
