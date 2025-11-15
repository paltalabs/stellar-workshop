# Arbitrage Flash Loan Contract

A Soroban smart contract that executes atomic arbitrage trades using flash loans from Blend Protocol.

## Features

- **Flash Loan Integration**: Implements Blend's `moderc3156` interface for secure flash loan callbacks
- **Generic Invocations**: Flexible invocation pattern supports any DEX protocol without contract upgrades
- **Atomic Execution**: All swaps execute atomically - profit or complete revert
- **Profitability Validation**: Built-in profit threshold checking before transferring funds
- **Multi-DEX Support**: Works with Soroswap, Phoenix, Aqua, Comet, and any future DEX

## Architecture

### Flow

1. User calls `pwnd_arb()` with flash loan parameters and swap invocations
2. Contract stores invocations in temporary storage
3. Contract calls Blend Pool's `flash_loan()` function
4. Blend transfers borrowed asset to contract
5. Blend calls back to contract's `exec_op()` function
6. Contract executes all swap invocations sequentially
7. Blend automatically pulls back the loan amount
8. Contract validates profitability and transfers net profit to user

### Key Components

- **`pwnd_arb()`**: Main entry point for users
- **`exec_op()`**: Flash loan callback implementing moderc3156 interface
- **`blend.rs`**: Blend Protocol integration types and client
- **`error.rs`**: Custom error types

## Interface

### pwnd_arb

```rust
pub fn pwnd_arb(
    e: Env,
    caller: Address,              // User address (must authorize)
    blend_pool: Address,          // Blend pool contract address
    loan_asset: Address,          // Token to flash loan
    loan_amount: i128,            // Amount to borrow
    invocations: Vec<(Address, Symbol, Vec<Val>)>,  // DEX swap calls
    min_profit: i128,             // Minimum profit threshold
) -> Result<i128, ArbitrageError>
```

### Invocations Format

Each invocation is a tuple: `(contract_address, function_name, arguments)`

**Example** (Soroswap swap):
```rust
(
    soroswap_router_address,
    Symbol::new(&e, "swap_exact_tokens_for_tokens"),
    vec![
        amount_in.into_val(&e),
        amount_out_min.into_val(&e),
        path.into_val(&e),
        to.into_val(&e),
        deadline.into_val(&e),
    ]
)
```

## Supported DEX Protocols

### Soroswap
- Function: `swap_exact_tokens_for_tokens`
- Type: XYK (constant product)

### Phoenix
- Function: `swap` (via multihop router)
- Type: XYK (constant product)

### Aqua
- Function: `swap_chained`
- Type: StableSwap with amplification

### Comet
- Function: `swap_exact_amount_in`
- Type: Weighted pools

## Error Codes

| Error | Code | Description |
|-------|------|-------------|
| `InsufficientProfit` | 1 | Final profit < min_profit threshold |
| `InvalidInvocations` | 2 | Empty invocations or exceeds max (10) |
| `SwapFailed` | 3 | One of the swap invocations failed |
| `RepaymentFailed` | 4 | Insufficient balance to repay flash loan |
| `Unauthorized` | 5 | Caller didn't authorize the transaction |
| `InvalidParams` | 6 | Invalid parameters provided |

## Security Features

- **Authorization Check**: Requires caller authorization before execution
- **Balance Validation**: Ensures sufficient funds to repay loan before returning
- **Atomic Execution**: All swaps execute atomically via flash loan
- **Reentrancy Protection**: Soroban's built-in reentrancy guards
- **Invocation Limits**: Maximum 10 invocations per arbitrage

## Build

```bash
cargo build --target wasm32v1-none --release
```

Output: `target/wasm32v1-none/release/arbitrage.wasm`

## Deploy

```bash
# Deploy contract
soroban contract deploy \
  --wasm target/wasm32v1-none/release/arbitrage.wasm \
  --source YOUR_SECRET_KEY \
  --rpc-url https://soroban-rpc.mainnet.stellar.org \
  --network-passphrase "Public Global Stellar Network ; September 2015"
```

## Example Usage

See TypeScript bot (`../../bot/src/`) for complete integration examples.

### Basic Triangular Arbitrage

1. Flash loan XLM from Blend
2. Swap XLM → USDC on Soroswap
3. Swap USDC → AQUA on Phoenix
4. Swap AQUA → XLM on Aqua
5. Repay flash loan automatically
6. Receive net profit

### Cross-DEX Arbitrage

1. Flash loan USDC from Blend
2. Swap USDC → XLM on Soroswap (lower price)
3. Swap XLM → USDC on Phoenix (higher price)
4. Repay flash loan automatically
5. Receive price difference as profit

## Safety Considerations

1. **Gas Costs**: Ensure profit exceeds transaction fees by sufficient margin (recommend 2x)
2. **Slippage**: Use conservative `min_profit` thresholds to account for market movement
3. **MEV**: Transactions may be front-run on public mempools
4. **Flash Loan Fees**: Blend currently charges 0% but this may change
5. **Pool Liquidity**: Large trades may have significant slippage

## Testing

```bash
# Run unit tests
cargo test

# Run specific test
cargo test test_validate_invocations
```

## License

Apache-2.0

## Links

- [Blend Protocol Docs](https://docs.blend.capital/)
- [Soroban Docs](https://soroban.stellar.org/)
- [Stellar Developer Docs](https://developers.stellar.org/)
