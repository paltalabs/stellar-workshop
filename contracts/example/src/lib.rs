#![no_std]

use soroban_sdk::{
    contract, contractimpl, token, Address, Env, Symbol, Val, Vec, vec,
};

mod error;
mod blend;

use error::SoroswapError;
use blend::{FlashLoan, PoolContract, Request};

/// Flash loan receiver contract that implements Blend's moderc3156 interface
/// and executes arbitrage via generic invocations pattern
#[contract]
pub struct PwndArbitrage;

/// Flash loan parameters for Blend protocol
#[contractimpl]
impl PwndArbitrage {
    /// Main entry point for executing arbitrage with flash loan
    ///
    /// Flow:
    /// 1. Stores invocations and parameters in temporary storage
    /// 2. Calls Blend pool's flash_loan function
    /// 3. Blend transfers loan_asset to this contract
    /// 4. Blend calls back to exec_op()
    /// 5. exec_op() executes the stored invocations
    /// 6. Blend pulls back the loan amount (automatic)
    /// 7. Validates profitability and returns net profit
    ///
    /// # Arguments
    /// * `caller` - Address initiating the arbitrage (must authorize)
    /// * `blend_pool` - Blend pool contract address for flash loan
    /// * `loan_asset` - Token address to borrow
    /// * `loan_amount` - Amount to borrow (in token base units)
    /// * `invocations` - Vector of (contract_address, function_name, args) for DEX swaps
    /// * `min_profit` - Minimum profit threshold (reverts if not met)
    ///
    /// # Returns
    /// Net profit amount (total received - loan amount)
    ///
    /// # Errors
    /// * `Unauthorized` - If caller doesn't authorize
    /// * `InvalidInvocations` - If invocations vector is empty or exceeds max
    /// * `InsufficientProfit` - If final profit < min_profit
    pub fn pwnd_arb(
        e: Env,
        caller: Address,
        blend_pool: Address,
        loan_asset: Address,
        loan_amount: i128,
        invocations: Vec<(Address, Symbol, Vec<Val>)>,
        min_profit: i128,
    ) -> Result<i128, SoroswapError> {
        // Require caller authorization
        caller.require_auth();

        // Validate invocations
        if invocations.is_empty() || invocations.len() > 10 {
            return Err(SoroswapError::InvalidInvocations);
        }

        // Validate amounts
        if loan_amount <= 0 || min_profit < 0 {
            return Err(SoroswapError::InvalidParams);
        }

        // Store parameters in temporary storage for exec_op callback
        e.storage().temporary().set(
            &Symbol::new(&e, "INVOCS"),
            &invocations,
        );
        e.storage().temporary().set(
            &Symbol::new(&e, "LNASSET"),
            &loan_asset,
        );
        e.storage().temporary().set(
            &Symbol::new(&e, "LNAMT"),
            &loan_amount,
        );
        e.storage().temporary().set(
            &Symbol::new(&e, "MINPROF"),
            &min_profit,
        );
        e.storage().temporary().set(
            &Symbol::new(&e, "CALLER"),
            &caller,
        );

        // Record initial balance before flash loan
        let token_client = token::Client::new(&e, &loan_asset);
        let initial_balance = token_client.balance(&e.current_contract_address());

        // Create FlashLoan struct for Blend
        let flash_loan = FlashLoan {
            contract: e.current_contract_address(), // This contract receives the callback
            asset: loan_asset.clone(),
            amount: loan_amount,
        };

        // Create requests vector with Repay action
        // This satisfies Blend's health factor check by marking the flash loan as "will be repaid"
        // Blend processes this BEFORE the health check, so our position shows zero debt
        // The actual repayment still happens in exec_op after swaps complete
        let mut requests: Vec<Request> = Vec::new(&e);
        requests.push_back(Request {
            request_type: 5, // RequestType::Repay
            address: loan_asset.clone(),
            amount: loan_amount,
        });

        // Call Blend pool's flash_loan function
        // This will:
        // 1. Transfer loan_asset to our contract
        // 2. Call our exec_op() function (callback)
        // 3. Pull back the loan_amount automatically
        // 4. Verify our position is healthy
        PoolContract::flash_loan(
            &e,
            &blend_pool,
            &caller,
            &flash_loan,
            &requests,
        );

        // After flash loan completes, check final balance
        let final_balance = token_client.balance(&e.current_contract_address());
        let net_profit = final_balance - initial_balance;

        // Validate profitability
        if net_profit < min_profit {
            return Err(SoroswapError::InsufficientProfit);
        }

        // Transfer profit to caller
        if net_profit > 0 {
            token_client.transfer(
                &e.current_contract_address(),
                &caller,
                &net_profit,
            );
        }

        Ok(net_profit)
    }

    /// Blend flash loan callback (moderc3156 interface)
    ///
    /// Called by Blend pool after flash loan is issued.
    /// Executes stored invocations and ensures loan is repaid.
    ///
    /// # Arguments
    /// * `caller` - Original user who requested flash loan
    /// * `token` - Flash loaned asset address
    /// * `amount` - Flash loan amount
    /// * `fee` - Flash loan fee (currently 0 on Blend)
    pub fn exec_op(
        e: Env,
        caller: Address,
        token: Address,
        amount: i128,
        fee: i128,
    ) -> Result<(), SoroswapError> {
        // Retrieve stored parameters
        let invocations: Vec<(Address, Symbol, Vec<Val>)> = e
            .storage()
            .temporary()
            .get(&Symbol::new(&e, "INVOCS"))
            .ok_or(SoroswapError::InvalidParams)?;

        let loan_asset: Address = e
            .storage()
            .temporary()
            .get(&Symbol::new(&e, "LNASSET"))
            .ok_or(SoroswapError::InvalidParams)?;

        let loan_amount: i128 = e
            .storage()
            .temporary()
            .get(&Symbol::new(&e, "LNAMT"))
            .ok_or(SoroswapError::InvalidParams)?;

        let stored_caller: Address = e
            .storage()
            .temporary()
            .get(&Symbol::new(&e, "CALLER"))
            .ok_or(SoroswapError::InvalidParams)?;

        // Verify callback parameters match stored values
        if token != loan_asset || amount != loan_amount || caller != stored_caller {
            return Err(SoroswapError::InvalidParams);
        }

        // Execute all invocations sequentially
        for (contract_address, method, args) in invocations.iter() {
            // Invoke DEX swap contract
            let result = e.try_invoke_contract::<Val, Val>(
                &contract_address,
                &method,
                args,
            );

            // Check if invocation succeeded
            if result.is_err() {
                return Err(SoroswapError::SwapFailed);
            }
        }

        // Calculate total repayment amount (amount + fee)
        let repayment_amount = amount + fee;

        // Repay flash loan to Blend
        let token_client = token::Client::new(&e, &token);
        let current_balance = token_client.balance(&e.current_contract_address());

        // Ensure we have enough to repay
        if current_balance < repayment_amount {
            return Err(SoroswapError::RepaymentFailed);
        }

        // The token transfer to repay the loan will happen automatically
        // as the Blend protocol expects the balance to be available
        // We just need to ensure we have enough balance (already checked above)

        Ok(())
    }

    pub fn pwnd_exec(
        e: Env,
        caller: Address,
        invocations: Vec<(Address, Symbol, Vec<Val>, bool)>,
    ) -> Vec<Val> {
        // This require_auth is here so we don't get the error "[recording authorization only] encountered authorization not tied to the root contract invocation for an address. Use `require_auth()` in the top invocation or enable non-root authorization."
        caller.require_auth();
        e.storage().instance().extend_ttl(17280 * 3, 17280 * 7);
        let mut results: Vec<Val> = vec![&e];
        for (contract, method, args, can_fail) in invocations {
            if can_fail {
                let result = e.try_invoke_contract::<Val, Val>(&contract, &method, args);
                match result {
                    Ok(v) => results.push_back(v.unwrap()),
                    Err(err) => results.push_back(err.unwrap()),
                }
            } else {
                results.push_back(e.invoke_contract::<Val>(&contract, &method, args));
            }
        }
        results
    }
}

#[cfg(test)]
mod test;
