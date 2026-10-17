//! Records compute units, transaction sizes, account rent and deployment cost to
//! artifacts/program/measurements.json, and checks the published IDL against the instruction
//! layout the tests (and clients) use.

mod common;

use std::collections::BTreeMap;

use common::*;
use serde_json::{json, Value};
use solana_address::Address;

/// Client compute-unit requests recommended in docs/protocol.md section 9.4.
const LIMITS: [(&str, u64); 9] = [
    ("initialize_pool", 200_000),
    ("deposit", 100_000),
    ("refund_pending_deposit", 100_000),
    ("insert_leaf", 300_000),
    ("skip_refunded_deposit", 100_000),
    ("update_approved_root", 100_000),
    ("spend_private", 400_000),
    ("exit_public", 300_000),
    ("update_config", 100_000),
];
const LAMPORTS_PER_SOL: f64 = 1_000_000_000.0;
const PACKET: usize = 1232;
const PROGRAMDATA_METADATA: usize = 45;
const BUFFER_METADATA: usize = 37;
const PROGRAM_ACCOUNT: usize = 36;

#[test]
fn measure_instructions_and_costs() {
    let mut env = Env::new();
    env.advance(Stage::Change1Inserted);
    ok(env.spend("change_1_full"));
    ok(env.exit("bob"));
    let ix = env.ix_refund("A", "dave", 3, env.ata_of("dave"));
    assert!(env.send("x", vec![ix], &["dave"]).is_err());

    // The largest spend (relayer signing besides the sponsor, fee account present) through a lookup table.
    let mut alt_env = Env::new();
    alt_env.advance(Stage::Change0Inserted);
    let s = alt_env.spend_args("change_0");
    let ix = alt_env.ix_spend("A", &s, Some(alt_env.key("relayer")));
    let legacy_two_signers = {
        let mut probe = Env::new();
        probe.advance(Stage::Change0Inserted);
        let r = probe.spend("change_0");
        ok(r);
        probe.log.last().unwrap().2
    };
    let pool = alt_env.pool("A");
    let table_addrs = vec![pool.state, pool.approval, pool.vault, pool.vault_authority, TOKEN, SYSTEM];
    let table = alt_env.put_lookup_table(Address::new_unique(), &table_addrs);
    alt_env.svm.warp_to_slot(u64v(&alt_env.fx["spendSlot"]) + 1);
    let (r, alt_size) = alt_env.send_v0("spend_private_v0", vec![ix], &["relayer"], &table);
    ok(r);

    let mut per_ix: BTreeMap<String, (u64, u64, usize, usize, usize)> = BTreeMap::new();
    for (label, cu, size) in &env.log {
        let e = per_ix.entry(label.clone()).or_insert((u64::MAX, 0, usize::MAX, 0, 0));
        e.0 = e.0.min(*cu);
        e.1 = e.1.max(*cu);
        e.2 = e.2.min(*size);
        e.3 = e.3.max(*size);
        e.4 += 1;
    }
    let mut instructions = serde_json::Map::new();
    for (name, limit) in LIMITS {
        let Some((min_cu, max_cu, min_sz, max_sz, n)) = per_ix.get(name).copied() else {
            panic!("{name} not measured");
        };
        assert!(max_cu <= limit, "{name}: {max_cu} CU exceeds the recommended {limit}");
        assert!(max_sz <= PACKET, "{name}: {max_sz} bytes exceeds the packet limit");
        instructions.insert(
            name.into(),
            json!({
                "samples": n,
                "computeUnitsMin": min_cu,
                "computeUnitsMax": max_cu,
                "recommendedComputeUnitLimit": limit,
                "legacyTxBytesMin": min_sz,
                "legacyTxBytesMax": max_sz,
            }),
        );
    }
    instructions["spend_private"]["relayerSignsSeparately_legacyTxBytes"] = json!(legacy_two_signers);
    instructions["spend_private"]["relayerSignsSeparately_v0WithLookupTable_txBytes"] = json!(alt_size);

    let rent = |n: usize| env.svm.minimum_balance_for_rent_exemption(n);
    let mut accounts = serde_json::Map::new();
    for (name, size) in [
        ("PoolState", 1407usize),
        ("ApprovalState", 121),
        ("PendingDeposit", 234),
        ("PendingChange", 130),
        ("SeenPrecommitment", 49),
        ("SpentNullifier", 50),
        ("TokenVault (SPL token account)", 165),
    ] {
        accounts.insert(name.into(), json!({ "bytes": size, "rentExemptLamports": rent(size) }));
    }
    // Sizes of live accounts match the protocol layouts.
    let a = env.pool("A");
    assert_eq!(env.account(&a.state).unwrap().data.len(), 1407);
    assert_eq!(env.account(&a.approval).unwrap().data.len(), 121);
    assert_eq!(env.account(&env.deposit_pda("A", 0)).unwrap().data.len(), 234);
    let nf = env.spend_args("alice_0").nullifier_hash;
    assert_eq!(env.account(&env.change_pda("A", &nf)).unwrap().data.len(), 130);
    assert_eq!(env.account(&env.nullifier_pda("A", &nf)).unwrap().data.len(), 50);

    let so = std::fs::read(std::env::var("VEILO_POOL_DEVNET_SO").expect("VEILO_POOL_DEVNET_SO")).unwrap();
    let so_len = so.len();
    let programdata_rent = rent(PROGRAMDATA_METADATA + so_len);
    let program_rent = rent(PROGRAM_ACCOUNT);
    let buffer_rent = rent(BUFFER_METADATA + so_len);
    // `solana program deploy` writes the buffer in chunks that fit one transaction.
    let write_chunk = 1_012usize;
    let write_txs = so_len.div_ceil(write_chunk);
    let deploy_fees = (write_txs as u64 + 4) * 5_000 * 2;
    let init_rent = rent(1407) + rent(121) + rent(165);
    let deploy = json!({
        "binary": "devnet feature build (cargo build-sbf --arch v3, platform-tools v1.57)",
        "binaryBytes": so_len,
        "programDataBytes": PROGRAMDATA_METADATA + so_len,
        "programDataRentLamports": programdata_rent,
        "programAccountRentLamports": program_rent,
        "bufferRentLamportsRefundedAfterDeploy": buffer_rent,
        "estimatedWriteTransactions": write_txs,
        "estimatedDeployFeesLamports": deploy_fees,
        "initializePoolRentLamports": init_rent,
        "lockedAfterDeploySol": (programdata_rent + program_rent + init_rent) as f64 / LAMPORTS_PER_SOL,
        "peakDuringDeploySol": (programdata_rent + program_rent + buffer_rent + deploy_fees + init_rent) as f64 / LAMPORTS_PER_SOL,
    });
    let per_op = json!({
        "depositRentLamports": rent(234) + rent(49),
        "spendRentLamports": rent(130) + rent(50),
        "exitRentLamports": rent(50),
        "note": "No v1 program account is ever closed; rent is paid by the payer/sponsor.",
    });

    // LiteSVM loads p-token under the upgradeable loader when its feature is active, else SPL Token 3.5.0.
    let token_impl = if env.svm.get_account(&TOKEN).unwrap().owner == LOADER_V3 { "p-token (pinocchio)" } else { "spl-token 3.5.0" };
    let out = json!({
        "harness": "LiteSVM 0.17.0 (Agave 4.3 runtime, default feature set), localnet program build",
        "tokenProgramImplementation": token_impl,
        "computeUnitsInclude": "the 150 CU SetComputeUnitLimit instruction",
        "packetLimitBytes": PACKET,
        "instructions": instructions,
        "lookupTable": {
            "required": false,
            "addresses": ["pool_state", "approval_state", "vault", "vault_authority", "token_program", "system_program"],
            "reason": "every measured legacy transaction fits the 1232-byte packet; the table is an optional size reduction for spend_private",
        },
        "accounts": accounts,
        "perOperationRent": per_op,
        "deployment": deploy,
    });
    let path = repo("artifacts/program/measurements.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

/// Account names and argument names per instruction, in protocol order.
const LAYOUT: [(&str, &[&str], &[&str]); 9] = [
    (
        "initialize_pool",
        &["deployer", "program_data", "pool_state", "vault_authority", "mint", "vault", "approval_state", "token_program", "associated_token_program", "system_program"],
        &["pool_id", "genesis_hash", "expected_decimals", "approval_authority", "config_authority"],
    ),
    (
        "deposit",
        &["depositor", "payer", "pool_state", "source", "vault", "pending_deposit", "seen_precommitment", "token_program", "system_program"],
        &["amount", "precommitment", "salt"],
    ),
    (
        "refund_pending_deposit",
        &["refund_authority", "pool_state", "pending_deposit", "vault", "vault_authority", "destination", "token_program"],
        &[],
    ),
    ("insert_leaf", &["submitter", "pool_state", "pending_deposit", "pending_change"], &["proof", "new_root"]),
    ("skip_refunded_deposit", &["submitter", "pool_state", "pending_deposit"], &[]),
    ("update_approved_root", &["approval_authority", "pool_state", "approval_state"], &["new_root"]),
    (
        "spend_private",
        &[
            "payer", "relayer", "pool_state", "approval_state", "vault", "vault_authority", "destination", "relayer_fee_account",
            "spent_nullifier", "pending_change", "token_program", "system_program",
        ],
        &["proof", "state_root", "nullifier_hash", "new_commitment", "intent"],
    ),
    (
        "exit_public",
        &["refund_authority", "payer", "pool_state", "vault", "vault_authority", "destination", "spent_nullifier", "token_program", "system_program"],
        &["proof", "state_root", "nullifier_hash", "value", "salt"],
    ),
    ("update_config", &["config_authority", "pool_state"], &["args"]),
];

#[test]
fn published_idl_matches_instruction_layout() {
    let idl: Value = serde_json::from_str(&std::fs::read_to_string(repo("artifacts/program/privacy_pool.json")).expect("artifacts/program/privacy_pool.json")).unwrap();
    let fx = fixtures();
    assert_eq!(idl["address"].as_str().map(|a| Address::from_str_const(a).to_bytes()), Some(h32(fx["programId"].as_str().unwrap())));
    let ixs = idl["instructions"].as_array().unwrap();
    assert_eq!(ixs.len(), LAYOUT.len());
    for (name, accounts, args) in LAYOUT {
        let ix = ixs.iter().find(|i| i["name"] == name).unwrap_or_else(|| panic!("{name} missing from IDL"));
        let d: Vec<u8> = ix["discriminator"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
        assert_eq!(d, disc("global", name), "{name} discriminator");
        let names: Vec<&str> = ix["accounts"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect();
        assert_eq!(names, accounts, "{name} accounts");
        let arg_names: Vec<&str> = ix["args"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect();
        assert_eq!(arg_names, args, "{name} args");
    }
    for acc in idl["accounts"].as_array().unwrap() {
        let n = acc["name"].as_str().unwrap();
        let d: Vec<u8> = acc["discriminator"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
        assert_eq!(d, disc("account", n), "{n} account discriminator");
    }
    let errors: Vec<(u64, &str)> = idl["errors"].as_array().unwrap().iter().map(|e| (e["code"].as_u64().unwrap(), e["name"].as_str().unwrap())).collect();
    assert_eq!(errors.len(), 36);
    assert_eq!(errors[0], (6000, "NonCanonicalFieldElement"));
    assert_eq!(errors[35], (6035, "ConfigOutOfBounds"));
}
