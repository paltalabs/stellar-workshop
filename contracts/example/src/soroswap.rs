use soroban_sdk::{contracttype, Address, Env, IntoVal, Vec};

/// Flash loan parameters for Blend protocol
#[contracttype]
#[derive(Clone, Debug)]
pub struct FlashLoan {
    /// Receiver contract address (implements exec_op)
    pub contract: Address,
    /// Asset to borrow
    pub asset: Address,
    /// Amount to borrow
    pub amount: i128,
}

/// Request types for additional pool operations
#[contracttype]
#[derive(Clone, Debug)]
pub struct Request {
    /// Request type (see RequestType enum)
    pub request_type: u32,
    /// Asset address or liquidatee address
    pub address: Address,
    /// Amount for the request
    pub amount: i128,
}

/// Request type enum values
#[allow(dead_code)]
pub enum RequestType {
    Supply = 0,
    Withdraw = 1,
    SupplyCollateral = 2,
    WithdrawCollateral = 3,
    Borrow = 4,
    Repay = 5,
    FillUserLiquidationAuction = 6,
    FillBadDebtAuction = 7,
    FillInterestAuction = 8,
    DeleteLiquidationAuction = 9,
}

/// Blend Pool contract client
/// Use this to interact with Blend's flash_loan function
pub struct SoroswapRouter;

impl SoroswapRouter {
    /// Call flash_loan on the Blend pool contract
    ///
    /// This will:
    /// 1. Transfer `loan_asset` to the `flash_loan.contract` (receiver)
    /// 2. Call `exec_op` on the receiver contract
    /// 3. Process any additional `requests`
    /// 4. Verify the loan is repaid
    /// 5. Check user position health
    pub fn flash_loan(
        e: &Env,
        pool_address: &Address,
        from: &Address,
        flash_loan: &FlashLoan,
        requests: &Vec<Request>,
    ) {
        // Invoke the pool contract's flash_loan function
        let fn_name = soroban_sdk::Symbol::new(e, "flash_loan");

        let _: soroban_sdk::Val = e.invoke_contract(
            pool_address,
            &fn_name,
            soroban_sdk::vec![
                e,
                from.into_val(e),
                flash_loan.into_val(e),
                requests.into_val(e),
            ],
        );
    }
}
