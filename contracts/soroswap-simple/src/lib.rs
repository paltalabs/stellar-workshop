#![no_std]
//! # Soroswap Simple - Direct Proxy Pattern
//!
//! This contract demonstrates the **direct proxy pattern** for integrating with Soroswap Router.
//!
//! ## Key Characteristics:
//! - Contract acts as a passthrough - never holds user tokens
//! - User authorizes the Router directly to transfer tokens on their behalf
//! - No additional authorization logic needed in this contract
//! - Token flow: User → Router (Pair) → User
//!
//! ## Why No Authorization is Needed:
//! The user's signature (`caller.require_auth()`) authorizes the Soroswap Router to transfer
//! tokens directly from the user's account. This contract simply orchestrates the call but
//! never takes custody of tokens, so no additional auth context is required.

use soroban_sdk::{
    contract, contractimpl, Address, Env, Vec,
};

mod soroswap_router;
mod storage;
mod error;

use soroswap_router::SoroswapRouterClient;
use storage::{
    extend_instance_ttl, get_soroswap_router_address, set_soroswap_router_address,
};
use error::SoroswapError;

/// Validates that the amount is non-negative
///
/// Prevents arithmetic issues and invalid swap amounts
pub fn check_nonnegative_amount(amount: i128) -> Result<(), SoroswapError> {
    if amount < 0 {
        Err(SoroswapError::NegativeNotAllowed)
    } else {
        Ok(())
    }
}

#[contract]
struct SoroswapSimple;

#[contractimpl]
impl SoroswapSimple {
    /// Initialize the contract with the Soroswap Router address
    ///
    /// This address is stored and used for all subsequent swap operations
    pub fn __constructor(e: Env, router_address: Address) {
        set_soroswap_router_address(&e, router_address);
    }

    /// Execute a token swap via Soroswap Router as a direct proxy
    ///
    /// ## Authorization Flow:
    /// 1. User signs the transaction (`caller.require_auth()`)
    /// 2. User's signature authorizes the Router to transfer tokens from their account
    /// 3. This contract acts as coordinator - tokens never pass through it
    ///
    /// ## Parameters:
    /// - `caller`: The user executing the swap (must sign the transaction)
    /// - `token_in`: Token being sold
    /// - `token_out`: Token being purchased
    /// - `amount`: Amount of `token_in` to swap
    ///
    /// ## Returns:
    /// Amount of `token_out` received from the swap
    pub fn swap(e: Env, caller: Address, token_in: Address, token_out: Address, amount: i128) -> Result<i128, SoroswapError> {
        // Verify the caller has signed this transaction
        caller.require_auth();
        check_nonnegative_amount(amount)?;
        extend_instance_ttl(&e);

        // Get the stored Soroswap Router address and create client
        let soroswap_router_address = get_soroswap_router_address(&e);
        let soroswap_router_client = SoroswapRouterClient::new(&e, &soroswap_router_address);

        // Build the swap path (direct pair: token_in -> token_out)
        let mut path: Vec<Address> = Vec::new(&e);
        path.push_back(token_in.clone());
        path.push_back(token_out.clone());

        // Execute the swap through the router
        // The caller's signature authorizes the router to transfer tokens directly
        // from their account - this contract never takes custody
        let swap_result = soroswap_router_client.swap_exact_tokens_for_tokens(
            &amount,     // Exact amount to swap
            &0,          // Minimum amount out (0 for simplicity; use slippage calculation in production)
            &path,       // Swap route
            &caller,     // Recipient of output tokens (same as sender in this case)
            &u64::MAX,   // Deadline (max for simplicity; use actual timestamp in production)
        );

        // Return the amount of token_out received
        let total_swapped_amount = swap_result.last().unwrap();

        Ok(total_swapped_amount)
    }
}
