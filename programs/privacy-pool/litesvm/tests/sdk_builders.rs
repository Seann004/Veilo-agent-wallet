//! Executes instructions built by the TypeScript SDK builders (`@veilo/privacy-sdk` program.ts,
//! as used by the wallet and relayer) against the program, for original and change notes.
//! Input: target/program-fixtures/sdk-builders.json from scripts/sdk-builder-fixtures.ts.

mod common;

use common::*;
use serde_json::Value;
use solana_instruction::{AccountMeta, Instruction};

fn sdk() -> Value {
    let path = repo("target/program-fixtures/sdk-builders.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}; run scripts/sdk-builder-fixtures.ts", path.display()))).unwrap()
}

fn ix_of(v: &Value) -> Instruction {
    Instruction {
        program_id: addr(v["programId"].as_str().unwrap()),
        accounts: v["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| AccountMeta { pubkey: addr(a["pubkey"].as_str().unwrap()), is_signer: a["signer"].as_bool().unwrap(), is_writable: a["writable"].as_bool().unwrap() })
            .collect(),
        data: hexv(v["data"].as_str().unwrap()),
    }
}

fn env_at(stage: Stage) -> Env {
    let mut env = Env::new();
    env.advance(stage);
    env
}

#[test]
fn sdk_builders_match_harness_instructions_byte_for_byte() {
    let env = Env::new();
    let s = sdk();
    for name in ["alice", "bob", "carol", "dave"] {
        let (owner, seq, amount, pre, salt) = env.fixture_deposit(name);
        assert_eq!(ix_of(&s["deposits"][name]), env.ix_deposit("A", &owner, seq, amount, pre, salt), "deposit {name}");
    }
    for name in ["alice_0", "change_0", "change_1_full", "bob_unapproved"] {
        let a = env.spend_args(name);
        assert_eq!(ix_of(&s["spends"][name]), env.ix_spend("A", &a, a.intent.relayer), "spend {name}");
    }
    for name in ["alice_0", "change_1", "bob"] {
        let e = env.exit_args(name);
        assert_eq!(ix_of(&s["exits"][name]), env.ix_exit("A", &e, &e.owner, env.ata_of(&e.owner)), "exit {name}");
    }
}

#[test]
fn sdk_deposit_is_accepted() {
    let mut env = env_at(Stage::Initialized);
    let s = sdk();
    let before = env.token_balance(&env.pool("A").vault);
    ok(env.send("sdk deposit", vec![ix_of(&s["deposits"]["alice"])], &["alice"]));
    assert_eq!(env.token_balance(&env.pool("A").vault), before + 5_000_000);
    assert_eq!(env.pool_state("A").queue_tail(), 1);
}

#[test]
fn sdk_spend_original_then_change_then_exit_change() {
    let mut env = env_at(Stage::Approved);
    let s = sdk();
    ok(env.send("sdk spend original", vec![ix_of(&s["spends"]["alice_0"])], &[]));
    assert_eq!(env.token_balance(&env.ata_of("w1")), 1_200_000);

    let nf0 = env.spend_args("alice_0").nullifier_hash;
    ok(env.insert("change_0", Record::Change(nf0)));
    ok(env.config(None, None, None, None, Some(10_000)));
    ok(env.send("sdk spend change", vec![ix_of(&s["spends"]["change_0"])], &["relayer"]));
    assert_eq!(env.token_balance(&env.ata_of("w2")), 790_000);
    assert_eq!(env.token_balance(&env.ata_of("relayer")), 10_000);

    let nf1 = env.spend_args("change_0").nullifier_hash;
    ok(env.insert("change_1", Record::Change(nf1)));
    let alice_before = env.token_balance(&env.ata_of("alice"));
    ok(env.send("sdk exit change", vec![ix_of(&s["exits"]["change_1"])], &["alice"]));
    assert_eq!(env.token_balance(&env.ata_of("alice")), alice_before + 3_000_000);
    // A replayed exit is rejected (here the drained liability fails before the nullifier account).
    assert!(env.send("sdk exit change again", vec![ix_of(&s["exits"]["change_1"])], &["alice"]).is_err());
}

#[test]
fn sdk_exit_original_note() {
    let mut env = env_at(Stage::Approved);
    let s = sdk();
    let before = env.token_balance(&env.ata_of("alice"));
    ok(env.send("sdk exit original", vec![ix_of(&s["exits"]["alice_0"])], &["alice"]));
    assert_eq!(env.token_balance(&env.ata_of("alice")), before + 5_000_000);
    // A spend of the exited note is rejected.
    assert!(env.send("sdk spend after exit", vec![ix_of(&s["spends"]["alice_0"])], &[]).is_err());
}
