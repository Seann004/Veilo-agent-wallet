//! Adversarial program tests with real Groth16 proofs. Test names carry the acceptance IDs.

mod common;

use common::*;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

const PENDING: u8 = 0;
const INSERTED: u8 = 1;
const REFUNDED: u8 = 2;
const SKIPPED: u8 = 3;

fn env_at(stage: Stage) -> Env {
    let mut env = Env::new();
    env.advance(stage);
    env
}

/// Asserts the pool's solvency invariants.
fn assert_solvent(env: &Env) {
    let pool = env.pool_state("A");
    assert_eq!(pool.liability(), pool.cumulative_deposited() - pool.cumulative_outflow());
    assert!(env.token_balance(&env.pool("A").vault) >= pool.liability());
}

#[test]
fn priv_01_spend_with_change_then_spend_change() {
    let mut env = env_at(Stage::Approved);
    let vault = env.pool("A").vault;
    let w1 = env.ata_of("w1");
    let s0 = env.spend_args("alice_0");
    let liability_before = env.pool_state("A").liability();
    assert_eq!(liability_before, 5_000_000 + 1_000_000 + 300_000);

    let vault_before = env.token_balance(&vault);
    ok(env.spend("alice_0"));
    assert_eq!(env.token_balance(&w1), 1_200_000);
    assert_eq!(env.token_balance(&vault), vault_before - 1_200_000);
    let pool = env.pool_state("A");
    assert_eq!(pool.liability(), liability_before - 1_200_000);
    assert_eq!(pool.queue_tail(), 5, "change record enqueued at the tail");
    assert_eq!(change_state(&env, &s0.nullifier_hash), PENDING);
    let nf = env.account(&env.nullifier_pda("A", &s0.nullifier_hash)).unwrap();
    assert_eq!(nf.owner, env.program);
    assert_eq!(nf.data[8 + 32], 1, "SpentNullifier kind = spend");

    // LED-01: the change note is not spendable before its insertion (its root is unknown).
    fails(&env.spend("change_0"), E::UnknownStateRoot);

    ok(env.insert("change_0", Record::Change(s0.nullifier_hash)));
    assert_eq!(change_state(&env, &s0.nullifier_hash), INSERTED);
    assert_eq!(env.pool_state("A").current_root(), env.root("R4"));
    ok(env.config(None, None, None, None, Some(10_000)));

    let s1 = env.spend_args("change_0");
    ok(env.spend("change_0"));
    assert_eq!(env.token_balance(&env.ata_of("w2")), 790_000);
    assert_eq!(env.token_balance(&env.ata_of("relayer")), 10_000);
    ok(env.insert("change_1", Record::Change(s1.nullifier_hash)));
    assert_eq!(env.pool_state("A").current_root(), env.root("R5"));

    // Spends the second change note in full (remainder 0 still creates a change record).
    let s2 = env.spend_args("change_1_full");
    ok(env.spend("change_1_full"));
    assert_eq!(env.token_balance(&env.ata_of("w3")), 3_000_000);
    assert_eq!(change_state(&env, &s2.nullifier_hash), PENDING);
    let pool = env.pool_state("A");
    assert_eq!(pool.liability(), 1_000_000 + 300_000);
    assert_eq!(pool.next_leaf_index(), 5);
    assert_eq!(pool.queue_head(), 6);
    assert_eq!(pool.queue_tail(), 7);
    assert_solvent(&env);
}

#[test]
fn priv_02_bad_proof_context_or_public_input_releases_nothing() {
    let mut env = env_at(Stage::Approved);
    let good = env.spend_args("alice_0");
    let watch = |env: &Env, s: &SpendArgs| {
        env.snapshot(&[
            env.pool("A").state,
            env.pool("A").vault,
            s.intent.destination_token_account,
            env.nullifier_pda("A", &s.nullifier_hash),
            env.change_pda("A", &s.nullifier_hash),
        ])
    };
    let mut cases: Vec<(&str, SpendArgs)> = Vec::new();

    let mut s = env.spend_args("alice_0");
    s.proof.c[40] ^= 1;
    cases.push(("tampered proof C", s));
    let mut s = env.spend_args("alice_0");
    s.proof.a = env.spend_args("change_0").proof.a;
    cases.push(("mixed proof points", s));
    let mut s = env.spend_args("alice_0");
    s.proof = env.spend_args("bob_unapproved").proof;
    cases.push(("proof of another statement", s));
    let mut s = env.spend_args("alice_0");
    s.intent.payout += 1;
    cases.push(("payout changed (context)", s));
    let mut s = env.spend_args("alice_0");
    s.intent.destination_owner = env.key("mallory");
    s.intent.destination_token_account = env.ata_of("mallory");
    cases.push(("destination redirected (context)", s));
    let mut s = env.spend_args("alice_0");
    s.new_commitment = plus_one(&s.new_commitment);
    cases.push(("new commitment changed", s));
    let mut s = env.spend_args("alice_0");
    s.nullifier_hash = plus_one(&s.nullifier_hash);
    cases.push(("nullifier hash changed", s));
    let mut s = env.spend_args("alice_0");
    s.state_root = env.root("R2");
    cases.push(("other known root", s));

    for (what, s) in cases {
        let before = watch(&env, &s);
        let ix = env.ix_spend("A", &s, None);
        fails(&env.send("spend_private", vec![ix], &[]), E::InvalidProof);
        assert_eq!(watch(&env, &s), before, "{what}: state changed");
    }
    // The untouched proof still settles afterwards.
    let ix = env.ix_spend("A", &good, None);
    ok(env.send("spend_private", vec![ix], &[]));
}

#[test]
fn priv_03_nullifier_reuse_spend_spend_and_spend_exit() {
    let mut env = env_at(Stage::Spent0);
    let w1 = env.ata_of("w1");
    let paid = env.token_balance(&w1);
    // Same proof again in a new transaction.
    fails_already_in_use(&env.spend("alice_0"));
    // Owner exit of the already spent note shares the nullifier namespace.
    fails_already_in_use(&env.exit("alice_0"));
    assert_eq!(env.token_balance(&w1), paid);
    assert_eq!(env.token_balance(&env.ata_of("alice")), 50_000_000 - 5_000_000);
}

/// An unrelated pending deposit, so liability never masks the nullifier check.
fn add_liquidity(env: &mut Env) {
    let tail = env.pool_state("A").queue_tail();
    let ix = env.ix_deposit("A", "mallory", tail, 20_000_000, [0x16; 32], [6; 32]);
    ok(env.send("deposit", vec![ix], &["mallory"]));
}

#[test]
fn priv_03_exit_then_spend_and_exit_twice() {
    let mut env = env_at(Stage::Change1Inserted);
    add_liquidity(&mut env);
    ok(env.exit("change_1"));
    fails_already_in_use(&env.spend("change_1_full"));
    fails_already_in_use(&env.exit("change_1"));
    assert_eq!(env.token_balance(&env.ata_of("w3")), 0);
    assert_solvent(&env);
}

#[test]
fn priv_03_spend_then_exit() {
    let mut env = env_at(Stage::Change1Inserted);
    add_liquidity(&mut env);
    ok(env.spend("change_1_full"));
    let alice = env.token_balance(&env.ata_of("alice"));
    fails_already_in_use(&env.exit("change_1"));
    assert_eq!(env.token_balance(&env.ata_of("alice")), alice);
}

#[test]
fn priv_04_wrong_root_out_of_field_and_wrapped_values() {
    let mut env = env_at(Stage::Approved);
    let send = |env: &mut Env, s: &SpendArgs| {
        let ix = env.ix_spend("A", s, None);
        env.send("spend_private", vec![ix], &[])
    };
    let mut s = env.spend_args("alice_0");
    s.state_root = plus_one(&s.state_root);
    fails(&send(&mut env, &s), E::UnknownStateRoot);
    // R4 is a real future root of this scenario, not yet in the history.
    let mut s = env.spend_args("alice_0");
    s.state_root = env.root("R4");
    fails(&send(&mut env, &s), E::UnknownStateRoot);

    let mut s = env.spend_args("alice_0");
    s.state_root = plus_r(&s.state_root);
    fails(&send(&mut env, &s), E::NonCanonicalFieldElement);
    let mut s = env.spend_args("alice_0");
    s.nullifier_hash = plus_r(&s.nullifier_hash);
    fails(&send(&mut env, &s), E::NonCanonicalFieldElement);
    let mut s = env.spend_args("alice_0");
    s.nullifier_hash = [0xff; 32];
    fails(&send(&mut env, &s), E::NonCanonicalFieldElement);
    let mut s = env.spend_args("alice_0");
    s.new_commitment = R;
    fails(&send(&mut env, &s), E::NonCanonicalFieldElement);
    let mut s = env.spend_args("alice_0");
    s.new_commitment = [0; 32];
    fails(&send(&mut env, &s), E::ZeroCommitment);

    let mut s = env.spend_args("alice_0");
    s.intent.payout = u64::MAX;
    s.intent.fee = 1;
    s.intent.relayer = Some(env.key("relayer"));
    s.intent.fee_account = Some(env.ata_of("relayer"));
    fails(&send(&mut env, &s), E::AmountOverflow);
    let mut s = env.spend_args("alice_0");
    s.intent.payout = 0;
    fails(&send(&mut env, &s), E::PayoutZero);
    let mut s = env.spend_args("alice_0");
    s.intent.fee = 1;
    fails(&send(&mut env, &s), E::RelayerFeeNotAllowed);
    // More than the pool owes can never be withdrawn, whatever the proof claims.
    let mut s = env.spend_args("alice_0");
    s.intent.payout = env.pool_state("A").liability() + 1;
    fails(&send(&mut env, &s), E::LiabilityUnderflow);

    // Exit: non-canonical root, claimed value off by one, zero value.
    let send_exit = |env: &mut Env, e: &ExitArgs| {
        let ix = env.ix_exit("A", e, &e.owner, env.ata_of(&e.owner));
        let owner = e.owner.clone();
        env.send("exit_public", vec![ix], &[&owner])
    };
    let mut e = env.exit_args("bob");
    e.state_root = plus_r(&e.state_root);
    fails(&send_exit(&mut env, &e), E::NonCanonicalFieldElement);
    let mut e = env.exit_args("alice_0");
    e.value += 1;
    fails(&send_exit(&mut env, &e), E::InvalidProof);
    let mut e = env.exit_args("alice_0");
    e.value = 0;
    fails(&send_exit(&mut env, &e), E::ZeroValueNotAllowed);

    // Root and approved-root updates also reject non-canonical encodings.
    let ix = env.ix_approve("A", "approver", R);
    fails(&env.send("update_approved_root", vec![ix], &["approver"]), E::NonCanonicalFieldElement);
    assert_solvent(&env);
}

#[test]
fn priv_05_forged_and_out_of_order_insertion() {
    let mut env = env_at(Stage::Deposited);
    let pool_before = env.pool_state("A").0;
    // A valid insert proof for bob's leaf at index 0 while alice's deposit is the head: the program
    // supplies alice's commitment as the leaf input, so the proof fails.
    let f = &env.fx["inserts"]["forged_bob_at_0"];
    let forged = Proof::from(&f["proof"]);
    let forged_root = h32(f["newRoot"].as_str().unwrap());
    let ix = env.ix_insert_raw("A", Some(env.deposit_pda("A", 0)), None, &forged, forged_root);
    fails(&env.send("insert_leaf", vec![ix], &[]), E::InvalidProof);
    // The same forged proof against bob's own record: bob is not the head.
    let ix = env.ix_insert_raw("A", Some(env.deposit_pda("A", 1)), None, &forged, forged_root);
    fails(&env.send("insert_leaf", vec![ix], &[]), E::NotQueueHead);
    // Out of order: bob's real proof before alice's.
    fails(&env.insert("bob", Record::Deposit(1)), E::NotQueueHead);
    // Alice's proof with a substituted new root.
    let proof = Proof::from(&env.fx["inserts"]["alice"]["proof"]);
    let alice_root = h32(env.fx["inserts"]["alice"]["newRoot"].as_str().unwrap());
    let ix = env.ix_insert_raw("A", Some(env.deposit_pda("A", 0)), None, &proof, forged_root);
    fails(&env.send("insert_leaf", vec![ix], &[]), E::InvalidProof);
    // Exactly one queue record must be supplied.
    let ix = env.ix_insert_raw("A", None, None, &proof, alice_root);
    fails(&env.send("insert_leaf", vec![ix], &[]), E::InvalidQueueItem);
    let ix = env.ix_insert_raw("A", Some(env.deposit_pda("A", 0)), Some(env.deposit_pda("A", 1)), &proof, alice_root);
    assert!(env.send("insert_leaf", vec![ix], &[]).is_err());
    assert_eq!(env.pool_state("A").0, pool_before, "rejected inserts changed pool state");

    ok(env.insert("alice", Record::Deposit(0)));
    assert_eq!(deposit_state(&env, "A", 0), INSERTED);
    // Replaying the accepted insert: the record is no longer the head.
    fails(&env.insert("alice", Record::Deposit(0)), E::NotQueueHead);
    let ix = env.ix_insert_raw("A", Some(env.deposit_pda("A", 1)), None, &proof, alice_root);
    fails(&env.send("insert_leaf", vec![ix], &[]), E::InvalidProof);
    ok(env.insert("bob", Record::Deposit(1)));
    assert_eq!(env.pool_state("A").current_root(), env.root("R2"));
}

#[test]
fn priv_05_duplicate_precommitment_rejected() {
    let mut env = env_at(Stage::Deposited);
    let (_, _, _, pre, _) = env.fixture_deposit("alice");
    let tail = env.pool_state("A").queue_tail();
    let mallory_before = env.token_balance(&env.ata_of("mallory"));
    let ix = env.ix_deposit("A", "mallory", tail, 100_000, pre, [7; 32]);
    fails_already_in_use(&env.send("deposit", vec![ix], &["mallory"]));
    assert_eq!(env.token_balance(&env.ata_of("mallory")), mallory_before);
    assert!(env.account(&env.deposit_pda("A", tail)).is_none());
    // Zero and non-canonical precommitments.
    let ix = env.ix_deposit("A", "mallory", tail, 100_000, [0; 32], [7; 32]);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::ZeroValueNotAllowed);
    let ix = env.ix_deposit("A", "mallory", tail, 100_000, plus_r(&pre), [7; 32]);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::NonCanonicalFieldElement);
}

#[test]
fn priv_05_genesis_reinit_and_upgrade_authority() {
    let mut env = Env::new();
    let ix = env.ix_initialize("A", "deployer", MAINNET_GENESIS, 6);
    fails(&env.send("initialize_pool", vec![ix], &["deployer"]), E::InvalidGenesis);
    let ix = env.ix_initialize("A", "deployer", [0; 32], 6);
    fails(&env.send("initialize_pool", vec![ix], &["deployer"]), E::InvalidGenesis);
    // Only the upgrade authority can initialize (prevents a front-run with foreign authorities).
    let ix = env.ix_initialize("A", "mallory", env.genesis(), 6);
    fails(&env.send("initialize_pool", vec![ix], &["mallory"]), E::NotUpgradeAuthority);
    // Wrong decimals, Token-2022 mint and Token-2022 program.
    let ix = env.ix_initialize("A", "deployer", env.genesis(), 9);
    fails(&env.send("initialize_pool", vec![ix], &["deployer"]), E::InvalidMint);
    let mint22 = Address::new_unique();
    env.put_account(mint22, TOKEN_2022, mint_data(6));
    let ix = env.ix_initialize_with("A", "deployer", env.genesis(), 6, mint22, TOKEN);
    fails(&env.send("initialize_pool", vec![ix], &["deployer"]), E::InvalidMint);
    let ix = env.ix_initialize_with("A", "deployer", env.genesis(), 6, env.mint, TOKEN_2022);
    fails(&env.send("initialize_pool", vec![ix], &["deployer"]), E::InvalidTokenProgram);
    assert!(env.account(&env.pool("A").state).is_none());

    env.init_pool("A");
    let pool = env.pool_state("A");
    assert_eq!(pool.current_root(), env.root("R0"), "empty root");
    assert_eq!(pool.roots_len(), 1);
    assert_eq!((pool.min_deposit(), pool.max_deposit(), pool.liability_cap(), pool.max_relayer_fee()), (100_000, 20_000_000, 100_000_000, 0));
    assert_eq!(pool.vault(), env.pool("A").vault.to_bytes());
    let approval = env.account(&env.pool("A").approval).unwrap();
    assert_eq!(&approval.data[8 + 32..8 + 64], env.key("approver").as_ref());
    assert_eq!(&approval.data[8 + 64..8 + 96], &env.root("R0"));

    let before = env.pool_state("A").0;
    let ix = env.ix_initialize("A", "deployer", env.genesis(), 6);
    fails_already_in_use(&env.send("initialize_pool", vec![ix], &["deployer"]));
    assert_eq!(env.pool_state("A").0, before);
}

#[test]
fn priv_06_unapproved_notes_cannot_spend_privately_but_exit() {
    let mut env = env_at(Stage::Change1Inserted);
    // Only the approval authority can move the approved root.
    let ix = env.ix_approve("A", "mallory", env.approved_root("RX"));
    fails(&env.send("update_approved_root", vec![ix], &["mallory"]), E::Unauthorized);
    // Alice's label is removed from the approved set.
    ok(env.approve("RB"));
    let approval = env.account(&env.pool("A").approval).unwrap();
    assert_eq!(u64::from_le_bytes(approval.data[8 + 96..8 + 104].try_into().unwrap()), 2, "version");

    // Change note: its proof was built against the previous approved root.
    fails(&env.spend("change_1_full"), E::InvalidProof);
    // Original note never approved: proof against a root that was never published.
    fails(&env.spend("bob_unapproved"), E::InvalidProof);

    let alice_before = env.token_balance(&env.ata_of("alice"));
    ok(env.exit("change_1"));
    assert_eq!(env.token_balance(&env.ata_of("alice")), alice_before + 3_000_000);
    let bob_before = env.token_balance(&env.ata_of("bob"));
    ok(env.exit("bob"));
    assert_eq!(env.token_balance(&env.ata_of("bob")), bob_before + 1_000_000);
    let nf = env.exit_args("bob").nullifier_hash;
    assert_eq!(env.account(&env.nullifier_pda("A", &nf)).unwrap().data[8 + 32], 2, "SpentNullifier kind = exit");
    assert_eq!(env.pool_state("A").liability(), 300_000);
    assert_solvent(&env);
}

#[test]
fn exit_01_attacker_signer_rejected_owner_succeeds() {
    let mut env = env_at(Stage::Change1Inserted);
    for name in ["bob", "change_1"] {
        let e = env.exit_args(name);
        // Attacker signs with the victim's valid proof and salt: the derived label differs.
        let ix = env.ix_exit("A", &e, "mallory", env.ata_of("mallory"));
        fails(&env.send("exit_public", vec![ix], &["mallory"]), E::InvalidProof);
        // Attacker cannot redirect the owner's payout either: destination is the signer's ATA.
        let ix = env.ix_exit("A", &e, "mallory", env.ata_of(&e.owner));
        fails(&env.send("exit_public", vec![ix], &["mallory"]), E::InvalidDestination);
        let ix = env.ix_exit("A", &e, &e.owner, env.ata_of("mallory"));
        let owner = e.owner.clone();
        fails(&env.send("exit_public", vec![ix], &[&owner]), E::InvalidDestination);
    }
    assert_eq!(env.token_balance(&env.ata_of("mallory")), 200_000_000);
    ok(env.exit("bob"));
    ok(env.exit("change_1"));
}

#[test]
fn exp_01_old_proof_after_valid_until_slot_rejected() {
    let mut env = env_at(Stage::Approved);
    let s = env.spend_args("alice_0");
    let until = s.intent.valid_until_slot;
    // Too far ahead: more than 750 slots beyond the current slot.
    let mut far = env.spend_args("alice_0");
    far.intent.valid_until_slot = u64v(&env.fx["spendSlot"]) + 751;
    let ix = env.ix_spend("A", &far, None);
    fails(&env.send("spend_private", vec![ix], &[]), E::IntentTooFarInFuture);

    env.svm.warp_to_slot(until + 1);
    // `send` signs with a fresh blockhash; the slot bound still rejects.
    fails(&env.spend("alice_0"), E::IntentExpired);
    // Extending the bound changes the context, so the old proof no longer verifies.
    let mut extended = env.spend_args("alice_0");
    extended.intent.valid_until_slot = until + 500;
    let ix = env.ix_spend("A", &extended, None);
    fails(&env.send("spend_private", vec![ix], &[]), E::InvalidProof);
    assert!(env.account(&env.nullifier_pda("A", &s.nullifier_hash)).is_none(), "nullifier must stay unused");
    // The note itself is still recoverable by owner exit.
    ok(env.exit("alice_0"));
}

#[test]
fn exp_01_valid_until_slot_is_inclusive() {
    let mut env = env_at(Stage::Approved);
    let until = env.spend_args("alice_0").intent.valid_until_slot;
    env.svm.warp_to_slot(until);
    ok(env.spend("alice_0"));
}

#[test]
fn refund_then_insert_is_rejected_and_skipped() {
    let mut env = env_at(Stage::TwoInserted);
    let carol = env.ata_of("carol");
    let carol_before = env.token_balance(&carol);
    // Non-owner and wrong destination.
    let ix = env.ix_refund("A", "mallory", 2, env.ata_of("mallory"));
    fails(&env.send("refund_pending_deposit", vec![ix], &["mallory"]), E::Unauthorized);
    let ix = env.ix_refund("A", "carol", 2, env.ata_of("mallory"));
    fails(&env.send("refund_pending_deposit", vec![ix], &["carol"]), E::InvalidDestination);
    // A pending record cannot be skipped.
    let ix = env.ix_skip("A", 2);
    fails(&env.send("skip_refunded_deposit", vec![ix], &[]), E::QueueItemNotRefunded);

    let ix = env.ix_refund("A", "carol", 2, carol);
    ok(env.send("refund_pending_deposit", vec![ix], &["carol"]));
    assert_eq!(env.token_balance(&carol), carol_before + 2_000_000);
    assert_eq!(deposit_state(&env, "A", 2), REFUNDED);
    // Refund pays once.
    let ix = env.ix_refund("A", "carol", 2, carol);
    fails(&env.send("refund_pending_deposit", vec![ix], &["carol"]), E::DepositNotPending);
    // An insert proof built for carol's record before the refund changes nothing.
    let before = env.pool_state("A").0;
    fails(&env.insert("carol_refunded", Record::Deposit(2)), E::QueueItemNotPending);
    assert_eq!(env.pool_state("A").0, before);
    // The next record cannot jump the tombstone.
    fails(&env.insert("dave", Record::Deposit(3)), E::NotQueueHead);

    let ix = env.ix_skip("A", 2);
    ok(env.send("skip_refunded_deposit", vec![ix], &[]));
    assert_eq!(deposit_state(&env, "A", 2), SKIPPED);
    let pool = env.pool_state("A");
    assert_eq!((pool.queue_head(), pool.next_leaf_index()), (3, 2), "skip consumes no leaf index");
    let ix = env.ix_skip("A", 2);
    fails(&env.send("skip_refunded_deposit", vec![ix], &[]), E::NotQueueHead);
    // The proof for the next record, built for leaf index 2, is unaffected by the skip.
    ok(env.insert("dave", Record::Deposit(3)));
    assert_eq!(env.pool_state("A").current_root(), env.root("R3"));
    assert_solvent(&env);
}

#[test]
fn insert_then_refund_is_rejected() {
    let mut env = env_at(Stage::DaveInserted);
    let dave = env.ata_of("dave");
    let before = env.token_balance(&dave);
    let ix = env.ix_refund("A", "dave", 3, dave);
    fails(&env.send("refund_pending_deposit", vec![ix], &["dave"]), E::DepositNotPending);
    let ix = env.ix_refund("A", "alice", 0, env.ata_of("alice"));
    fails(&env.send("refund_pending_deposit", vec![ix], &["alice"]), E::DepositNotPending);
    assert_eq!(env.token_balance(&dave), before);
    assert_eq!(deposit_state(&env, "A", 3), INSERTED);
}

#[test]
fn substituted_cross_pool_accounts_rejected() {
    let mut env = env_at(Stage::Approved);
    env.init_pool("B");
    let pre_b = plus_one(&[0x11; 32]);
    let ix = env.ix_deposit("B", "mallory", 0, 100_000, pre_b, [9; 32]);
    ok(env.send("deposit", vec![ix], &["mallory"]));
    let (a_vault, b_vault, b_approval) = (env.pool("A").vault, env.pool("B").vault, env.pool("B").approval);

    // Deposit into A paying B's vault.
    let tail = env.pool_state("A").queue_tail();
    let ix = env.ix_deposit_raw("A", "mallory", env.ata_of("mallory"), b_vault, tail, 100_000, plus_one(&pre_b), [9; 32], TOKEN);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::InvalidVault);
    // Spend on A with B's approval state or B's vault.
    let s = env.spend_args("alice_0");
    let ix = env.ix_spend_with("A", &s, None, None, b_approval, a_vault, TOKEN);
    let r = env.send("spend_private", vec![ix], &[]);
    assert!(matches!(custom_code(&r), Some(c) if c == E::PoolMismatch as u32 || c == ANCHOR_CONSTRAINT_SEEDS), "{}", describe(&r));
    let ix = env.ix_spend_with("A", &s, None, None, env.pool("A").approval, b_vault, TOKEN);
    fails(&env.send("spend_private", vec![ix], &[]), E::InvalidVault);
    // Insert on A with B's pending deposit.
    let f = &env.fx["inserts"]["alice"];
    let ix = env.ix_insert_raw("A", Some(env.deposit_pda("B", 0)), None, &Proof::from(&f["proof"]), h32(f["newRoot"].as_str().unwrap()));
    let r = env.send("insert_leaf", vec![ix], &[]);
    assert!(matches!(custom_code(&r), Some(c) if c == E::PoolMismatch as u32 || c == ANCHOR_CONSTRAINT_SEEDS), "{}", describe(&r));
    // Refund through B of A's pending record is impossible (all of A is inserted; use B's record via A).
    let mut ix = env.ix_refund("A", "mallory", 0, env.ata_of("mallory"));
    ix.accounts[2] = AccountMeta::new(env.deposit_pda("B", 0), false);
    let r = env.send("refund_pending_deposit", vec![ix], &["mallory"]);
    assert!(matches!(custom_code(&r), Some(c) if c == E::PoolMismatch as u32 || c == ANCHOR_CONSTRAINT_SEEDS), "{}", describe(&r));
    // A's exit proof on pool B: A's roots are unknown there.
    let e = env.exit_args("bob");
    let ix = env.ix_exit("B", &e, "bob", env.ata_of("bob"));
    fails(&env.send("exit_public", vec![ix], &["bob"]), E::UnknownStateRoot);
    // A's exit with B's vault.
    let mut ix = env.ix_exit("A", &e, "bob", env.ata_of("bob"));
    ix.accounts[3] = AccountMeta::new(b_vault, false);
    fails(&env.send("exit_public", vec![ix], &["bob"]), E::InvalidVault);
    // Wrong vault authority.
    let mut ix = env.ix_exit("A", &e, "bob", env.ata_of("bob"));
    ix.accounts[4] = AccountMeta::new_readonly(env.pool("B").vault_authority, false);
    fails_code(&env.send("exit_public", vec![ix], &["bob"]), ANCHOR_CONSTRAINT_SEEDS);
    // A look-alike PoolState owned by another program.
    let fake = Address::new_unique();
    let data = env.svm.get_account(&env.pool("A").state).unwrap().data;
    env.put_account(fake, Address::new_unique(), data);
    let mut ix = env.ix_exit("A", &e, "bob", env.ata_of("bob"));
    ix.accounts[2] = AccountMeta::new(fake, false);
    fails_code(&env.send("exit_public", vec![ix], &["bob"]), ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM);
    ok(env.exit("bob"));
}

#[test]
fn substituted_mint_token_program_and_destinations_rejected() {
    let mut env = env_at(Stage::Approved);
    let a_vault = env.pool("A").vault;
    let tail = env.pool_state("A").queue_tail();
    // Source of another mint.
    let other_mint = Address::new_unique();
    env.put_account(other_mint, TOKEN, mint_data(6));
    let other_src = Address::new_unique();
    env.put_account(other_src, TOKEN, token_account_data(&other_mint, &env.key("mallory"), 10_000_000));
    let ix = env.ix_deposit_raw("A", "mallory", other_src, a_vault, tail, 100_000, [0x21; 32], [1; 32], TOKEN);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::InvalidMint);
    // Token-2022 program.
    let ix = env.ix_deposit_raw("A", "mallory", env.ata_of("mallory"), a_vault, tail, 100_000, [0x21; 32], [1; 32], TOKEN_2022);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::InvalidTokenProgram);
    // Source not owned by the depositor.
    let ix = env.ix_deposit_raw("A", "mallory", env.ata_of("alice"), a_vault, tail, 100_000, [0x21; 32], [1; 32], TOKEN);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::InvalidTokenAccount);

    let s = env.spend_args("alice_0");
    let ix = env.ix_spend_with("A", &s, None, None, env.pool("A").approval, a_vault, TOKEN_2022);
    fails(&env.send("spend_private", vec![ix], &[]), E::InvalidTokenProgram);
    // Destination substitutions (checked before verification).
    let mut s = env.spend_args("alice_0");
    s.intent.destination_token_account = a_vault;
    s.intent.destination_owner = env.pool("A").vault_authority;
    let ix = env.ix_spend("A", &s, None);
    fails(&env.send("spend_private", vec![ix], &[]), E::InvalidDestination);
    let mut s = env.spend_args("alice_0");
    s.intent.destination_owner = env.key("mallory");
    let ix = env.ix_spend("A", &s, None);
    fails(&env.send("spend_private", vec![ix], &[]), E::InvalidDestination);
    let w1 = env.ata_of("w1");
    let mut wrong_mint = env.svm.get_account(&w1).unwrap();
    wrong_mint.data[0..32].copy_from_slice(other_mint.as_ref());
    env.svm.set_account(w1, wrong_mint).unwrap();
    fails(&env.spend("alice_0"), E::InvalidDestination);
    let mut frozen = token_account_data(&env.mint, &env.key("w1"), 0);
    frozen[108] = 2;
    env.put_account(w1, TOKEN, frozen);
    fails(&env.spend("alice_0"), E::InvalidDestination);
    env.put_account(w1, TOKEN, token_account_data(&env.mint, &env.key("w1"), 0));
    ok(env.spend("alice_0"));
}

#[test]
fn vault_delegate_or_close_authority_anomaly_rejected() {
    let mut env = env_at(Stage::Approved);
    let vault = env.pool("A").vault;
    let original = env.svm.get_account(&vault).unwrap();
    for (what, offset) in [("delegate", 72usize), ("close authority", 129usize)] {
        let mut acc = original.clone();
        acc.data[offset] = 1;
        acc.data[offset + 4..offset + 36].copy_from_slice(env.key("mallory").as_ref());
        env.svm.set_account(vault, acc).unwrap();
        fails(&env.deposit_like_mallory(), E::InvalidVault);
        let r = env.spend("alice_0");
        assert_eq!(custom_code(&r), Some(E::InvalidVault as u32), "{what}: {}", describe(&r));
        fails(&env.exit("bob"), E::InvalidVault);
        let ix = env.ix_refund("A", "carol", 2, env.ata_of("carol"));
        assert!(env.send("refund_pending_deposit", vec![ix], &["carol"]).is_err());
    }
    env.svm.set_account(vault, original).unwrap();
    ok(env.spend("alice_0"));
}

trait MalloryDeposit {
    fn deposit_like_mallory(&mut self) -> TxResult;
}

impl MalloryDeposit for Env {
    fn deposit_like_mallory(&mut self) -> TxResult {
        let tail = self.pool_state("A").queue_tail();
        let ix = self.ix_deposit("A", "mallory", tail, 200_000, [0x13; 32], [3; 32]);
        self.send("deposit", vec![ix], &["mallory"])
    }
}

#[test]
fn atomic_failure_leaves_no_partial_state() {
    let mut env = env_at(Stage::Approved);
    let s = env.spend_args("alice_0");
    let watched = [
        env.pool("A").state,
        env.pool("A").vault,
        env.ata_of("w1"),
        env.nullifier_pda("A", &s.nullifier_hash),
        env.change_pda("A", &s.nullifier_hash),
    ];
    let before = env.snapshot(&watched);

    // A valid spend followed by a failing instruction (overdrawn system transfer) in the same transaction.
    let unfunded = Address::new_unique();
    let failing = Instruction {
        program_id: SYSTEM,
        accounts: vec![AccountMeta::new(env.key("payer"), true), AccountMeta::new(unfunded, false)],
        data: {
            let mut d = 2u32.to_le_bytes().to_vec();
            d.extend_from_slice(&u64::MAX.to_le_bytes());
            d
        },
    };
    let ix = env.ix_spend("A", &s, None);
    assert!(env.send("spend_private", vec![ix, failing], &[]).is_err());
    assert_eq!(env.snapshot(&watched), before, "spend side effects survived a failed transaction");

    // The token CPI itself fails: the vault holds less than the payout (forced underfunding).
    let vault = env.pool("A").vault;
    let real = env.svm.get_account(&vault).unwrap();
    let mut short = real.clone();
    short.data[64..72].copy_from_slice(&1_000u64.to_le_bytes());
    env.svm.set_account(vault, short).unwrap();
    let before_short = env.snapshot(&watched);
    assert!(env.spend("alice_0").is_err());
    assert_eq!(env.snapshot(&watched), before_short);
    env.svm.set_account(vault, real).unwrap();

    // Deposit whose transfer fails (insufficient source balance) creates no records.
    let tail = env.pool_state("A").queue_tail();
    let poor = env.ata_of("w1");
    let ix = env.ix_deposit_raw("A", "w1", poor, vault, tail, 100_000, [0x14; 32], [4; 32], TOKEN);
    let pool_before = env.pool_state("A").0;
    assert!(env.send("deposit", vec![ix], &["w1"]).is_err());
    assert!(env.account(&env.deposit_pda("A", tail)).is_none());
    assert!(env.account(&env.seen_pda("A", &[0x14; 32])).is_none());
    assert_eq!(env.pool_state("A").0, pool_before);

    ok(env.spend("alice_0"));
}

#[test]
fn capacity_and_bounds_rejections() {
    let mut env = env_at(Stage::Initialized);
    let pre = |i: u64| {
        let mut p = [0x15u8; 32];
        p[24..].copy_from_slice(&i.to_be_bytes());
        p
    };
    let ix = env.ix_deposit("A", "mallory", 0, 99_999, pre(0), [5; 32]);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::DepositBelowMinimum);
    let ix = env.ix_deposit("A", "mallory", 0, 20_000_001, pre(0), [5; 32]);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::DepositAboveMaximum);
    // Five maximum deposits reach the 100,000,000 liability cap (pending deposits count).
    for i in 0..5 {
        let ix = env.ix_deposit("A", "mallory", i, 20_000_000, pre(i), [5; 32]);
        ok(env.send("deposit", vec![ix], &["mallory"]));
    }
    let ix = env.ix_deposit("A", "mallory", 5, 100_000, pre(5), [5; 32]);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::LiabilityCapExceeded);
    // Refunds lower the liability again.
    let ix = env.ix_refund("A", "mallory", 4, env.ata_of("mallory"));
    ok(env.send("refund_pending_deposit", vec![ix], &["mallory"]));
    let ix = env.ix_deposit("A", "mallory", 5, 100_000, pre(5), [5; 32]);
    ok(env.send("deposit", vec![ix], &["mallory"]));

    // Live queue limit: 64 records.
    for i in 6..64 {
        let ix = env.ix_deposit("A", "mallory", i, 100_000, pre(i), [5; 32]);
        ok(env.send("deposit", vec![ix], &["mallory"]));
    }
    let ix = env.ix_deposit("A", "mallory", 64, 100_000, pre(64), [5; 32]);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::QueueFull);

    // Tree capacity: deposits stop CHANGE_RESERVE slots before the end.
    let mut env = env_at(Stage::Initialized);
    let state = env.pool("A").state;
    let mut acc = env.svm.get_account(&state).unwrap();
    let mut view = PoolView(acc.data.clone());
    view.set_u64(PoolView::NEXT_LEAF_INDEX, 65_536 - 1_024);
    acc.data = view.0;
    env.svm.set_account(state, acc).unwrap();
    let ix = env.ix_deposit("A", "mallory", 0, 100_000, pre(0), [5; 32]);
    fails(&env.send("deposit", vec![ix], &["mallory"]), E::TreeCapacityExhausted);
}

#[test]
fn full_tree_blocks_spend_but_not_exit() {
    let mut env = env_at(Stage::Approved);
    let state = env.pool("A").state;
    let mut acc = env.svm.get_account(&state).unwrap();
    let mut view = PoolView(acc.data.clone());
    view.set_u64(PoolView::NEXT_LEAF_INDEX, 65_536);
    acc.data = view.0;
    env.svm.set_account(state, acc).unwrap();
    fails(&env.spend("alice_0"), E::TreeCapacityExhausted);
    ok(env.exit("alice_0"));
}

#[test]
fn update_config_is_bounded_and_cannot_block_exit() {
    let mut env = env_at(Stage::Approved);
    let ix = env.ix_config("A", "mallory", Some(true), None, None, None, None);
    fails(&env.send("update_config", vec![ix], &["mallory"]), E::Unauthorized);
    let ix = env.ix_config("A", "approver", Some(true), None, None, None, None);
    fails(&env.send("update_config", vec![ix], &["approver"]), E::Unauthorized);
    for (min, max, cap, fee) in [
        (None, Some(20_000_001), None, None),
        (None, None, Some(100_000_001), None),
        (None, None, None, Some(100_001)),
        (Some(0), None, None, None),
        (Some(5_000_000), Some(4_000_000), None, None),
        (None, Some(u64::MAX), Some(u64::MAX), Some(u64::MAX)),
    ] {
        fails(&env.config(None, min, max, cap, fee), E::ConfigOutOfBounds);
    }
    let before = env.pool_state("A").0;
    ok(env.config(Some(true), Some(200_000), Some(1_000_000), Some(1_000_000), Some(0)));
    let after = env.pool_state("A");
    assert!(after.deposits_paused());
    // Only the config fields (offsets 4 and 1287..1319 after the discriminator) changed.
    for (i, (a, b)) in before.iter().zip(after.0.iter()).enumerate() {
        let o = i as isize - 8;
        let config_field = o == 4 || (1287..1319).contains(&o);
        assert!(config_field || a == b, "byte {o} changed");
    }
    // Paused deposits; exit and refund keep working; the cap is below the liability.
    fails(&env.deposit_like_mallory(), E::DepositsPaused);
    ok(env.exit("bob"));
    ok(env.config(Some(false), None, None, None, None));
    fails(&env.deposit_like_mallory(), E::LiabilityCapExceeded);
    ok(env.exit("alice_0"));
}

#[test]
fn relayer_binding_rules() {
    let mut env = env_at(Stage::Change0Inserted);
    let s = env.spend_args("change_0");
    // Relayer named in the intent must sign.
    let ix = env.ix_spend("A", &s, None);
    fails(&env.send("spend_private", vec![ix], &[]), E::RelayerMismatch);
    let ix = env.ix_spend("A", &s, Some(env.key("mallory")));
    fails(&env.send("spend_private", vec![ix], &["mallory"]), E::RelayerMismatch);
    // Fee account must be the intent's.
    let ix = env.ix_spend_with("A", &s, Some(env.key("relayer")), Some(env.ata_of("mallory")), env.pool("A").approval, env.pool("A").vault, TOKEN);
    fails(&env.send("spend_private", vec![ix], &["relayer"]), E::RelayerFeeAccountMismatch);
    let ix = env.ix_spend_with("A", &s, Some(env.key("relayer")), None, env.pool("A").approval, env.pool("A").vault, TOKEN);
    fails(&env.send("spend_private", vec![ix], &["relayer"]), E::RelayerFeeAccountMismatch);
    // With the zero-fee default restored, any fee is rejected.
    ok(env.config(None, None, None, None, Some(0)));
    fails(&env.spend("change_0"), E::RelayerFeeNotAllowed);
    ok(env.config(None, None, None, None, Some(10_000)));
    ok(env.spend("change_0"));
}
