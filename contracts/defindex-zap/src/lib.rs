#![no_std]
//! # DeFindex Zap - Simple Proxy Zapper Pattern
//!
//! This contract demonstrates a **zapper** that combines multiple DeFi operations into one transaction.
//! Users can deposit ANY token into a DeFindex vault - the contract automatically swaps it to the
//! vault's underlying asset first.
//!
//! ## Key Characteristics:
//! - Contract acts as a coordinator - never holds user tokens
//! - Combines swap + deposit in a single transaction (improved UX)
//! - User authorizes both operations through one signature
//! - No additional authorization context needed (simple proxy pattern)
//! - Token flow: User → Router (swap) → User → Vault (deposit)
//!
//! ## Example Use Case:
//! - User has EURC but wants to deposit into an XLM vault
//! - Without zapper: User must manually swap EURC → XLM, then deposit XLM
//! - With zapper: User calls `deposit(EURC, amount)` and everything happens atomically
//!
//! ## Why No Authorization is Needed:
//! The user's signature (`caller.require_auth()`) authorizes this contract to coordinate both
//! the swap (via Soroswap Router) and the deposit (via DeFindex Vault) on their behalf. Since
//! the contract never takes custody of tokens, no additional authorization context is required.

use soroban_sdk::{
    Address, Env, Vec, contract, contractimpl, vec
};

mod defindex_vault;
mod soroswap_router;
mod storage;
mod error;

use defindex_vault::DeFindexVaultClient;
use soroswap_router::SoroswapRouterClient;
use storage::{
    extend_instance_ttl, get_vault_address, set_vault_address, get_soroswap_router_address, set_soroswap_router_address
};
use error::DeFindexError;

use crate::storage::{get_underlying_asset_address, set_underlying_asset_address};

/// Validates that the amount is non-negative
///
/// Prevents arithmetic issues and invalid swap amounts
pub fn check_nonnegative_amount(amount: i128) -> Result<(), DeFindexError> {
    if amount < 0 {
        Err(DeFindexError::NegativeNotAllowed)
    } else {
        Ok(())
    }
}

#[contract]
struct DeFindexSimple;

#[contractimpl]
impl DeFindexSimple {
    /// Initialize the zapper contract with required addresses
    ///
    /// ## Parameters:
    /// - `vault_address`: The DeFindex vault where deposits will be made
    /// - `router_address`: The Soroswap router used for token swaps
    /// - `underlying_asset`: The vault's underlying asset (target token for swaps)
    pub fn __constructor(e: Env, vault_address: Address, router_address: Address, underlying_asset: Address) {
        set_vault_address(&e, vault_address);
        set_soroswap_router_address(&e, router_address);
        set_underlying_asset_address(&e, underlying_asset);
    }

    /// Zap: Swap any token to vault's underlying asset and deposit in one transaction
    ///
    /// ## What This Does:
    /// 1. Swaps `token_in` → vault's `underlying_asset` via Soroswap Router
    /// 2. Deposits the swapped underlying asset into the DeFindex vault
    /// 3. All happens atomically in one user signature
    ///
    /// ## Authorization Flow (Simple Proxy):
    /// - User signs the transaction (`caller.require_auth()`)
    /// - User's signature authorizes:
    ///   1. Router to transfer `token_in` from user → pair (for the swap)
    ///   2. Vault to transfer `underlying_asset` from user → vault (for the deposit)
    /// - This contract acts as coordinator - tokens flow through user's account, not the contract
    /// - No additional authorization context needed
    ///
    /// ## Token Flow:
    /// ```
    /// User (token_in) → Router → Pair → User (underlying_asset) → Vault
    /// ```
    ///
    /// ## Parameters:
    /// - `caller`: The user depositing (must sign the transaction)
    /// - `token_in`: The token user is depositing (will be swapped to underlying asset)
    /// - `amount`: Amount of `token_in` to swap and deposit
    ///
    /// ## Returns:
    /// Amount of underlying asset deposited into the vault
    pub fn deposit(e: Env, caller: Address, token_in: Address, amount: i128) -> Result<i128, DeFindexError> {
        // Verify the caller has signed this transaction
        caller.require_auth();
        check_nonnegative_amount(amount)?;
        extend_instance_ttl(&e);

        // Get the vault's underlying asset (the target token for our swap)
        let underlying_asset = get_underlying_asset_address(&e);

        // Step 1: Swap token_in → underlying_asset via Soroswap Router
        let soroswap_router_address = get_soroswap_router_address(&e);
        let soroswap_router_client = SoroswapRouterClient::new(&e, &soroswap_router_address);

        // Build swap path (direct pair)
        let mut path: Vec<Address> = Vec::new(&e);
        path.push_back(token_in.clone());
        path.push_back(underlying_asset.clone());

        // Execute swap - tokens go from user → pair → back to user (as underlying_asset)
        // User's signature authorizes the router to transfer token_in from their account
        let swap_result = soroswap_router_client.swap_exact_tokens_for_tokens(
            &amount,     // Exact amount of token_in to swap
            &0,          // Minimum amount out (0 for simplicity; use slippage calculation in production)
            &path,       // Swap route: token_in → underlying_asset
            &caller,     // Recipient of swapped tokens (user receives underlying_asset)
            &u64::MAX,   // Deadline (max for simplicity; use actual timestamp in production)
        );

        // Get amount of underlying_asset received from swap
        let total_swapped_amount = swap_result.last().unwrap();

        // Step 2: Deposit the swapped underlying_asset into DeFindex vault
        let defindex_vault_address = get_vault_address(&e);
        let defindex_vault_client = DeFindexVaultClient::new(&e, &defindex_vault_address);

        // Deposit into vault - user's signature authorizes vault to transfer from their account
        defindex_vault_client.deposit(
            &vec![&e, total_swapped_amount],  // Amounts array (for multi-asset vaults; currently single-asset)
            &vec![&e, 0],                      // Minimum amounts out (slippage protection for multi-asset vaults)
            &caller,                            // Depositor (receives vault shares)
            &false                              // invest: false = keep as idle in vault; true = invest into strategy
        );

        // Return the amount deposited
        Ok(total_swapped_amount)
    }
}
