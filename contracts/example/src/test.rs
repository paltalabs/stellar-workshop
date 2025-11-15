#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol, Vec};

#[test]
fn test_validate_invocations() {
    let env = Env::default();
    let contract_id = env.register(PwndArbitrage, ());
    let client = PwndArbitrageClient::new(&env, &contract_id);

    let caller = Address::generate(&env);
    let blend_pool = Address::generate(&env);
    let loan_asset = Address::generate(&env);
    let invocations: Vec<(Address, Symbol, Vec<Val>)> = Vec::new(&env);

    // Test empty invocations should fail
    let result = client.try_pwnd_arb(
        &caller,
        &blend_pool,
        &loan_asset,
        &1000i128,
        &invocations,
        &100i128,
    );

    assert!(result.is_err());
}

#[test]
fn test_invalid_params() {
    let env = Env::default();
    let contract_id = env.register(PwndArbitrage, ());
    let client = PwndArbitrageClient::new(&env, &contract_id);

    let caller = Address::generate(&env);
    let blend_pool = Address::generate(&env);
    let loan_asset = Address::generate(&env);
    let invocations: Vec<(Address, Symbol, Vec<Val>)> = Vec::new(&env);

    // Test negative loan amount should fail
    let result = client.try_pwnd_arb(
        &caller,
        &blend_pool,
        &loan_asset,
        &-1000i128,
        &invocations,
        &100i128,
    );

    assert!(result.is_err());

    // Test negative min_profit should fail
    let result = client.try_pwnd_arb(
        &caller,
        &blend_pool,
        &loan_asset,
        &1000i128,
        &invocations,
        &-100i128,
    );

    assert!(result.is_err());
}

// Note: Full integration tests with mock Blend pool and DEX contracts
// should be added once the contract is ready for testnet deployment
