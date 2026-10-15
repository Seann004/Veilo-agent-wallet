//! Deploys the bench program into LiteSVM and records compute units for each verifier
//! using the proofs in artifacts/vectors/groth16-v1.json.

use std::path::PathBuf;

use litesvm::LiteSVM;
use serde_json::{json, Value};
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(rel)
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn data(kind: u8, case: &Value) -> Vec<u8> {
    let mut d = vec![kind];
    for k in ["a", "b", "c"] {
        d.extend(hex(case[k].as_str().unwrap()));
    }
    for x in case["publicInputs"].as_array().unwrap() {
        d.extend(hex(x.as_str().unwrap()));
    }
    d
}

#[test]
fn verifier_compute_units() {
    let so = std::env::var("VEILO_BENCH_SO").expect("VEILO_BENCH_SO points at the built bench program");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(repo("artifacts/vectors/groth16-v1.json")).unwrap()).unwrap();
    let mut svm = LiteSVM::new();
    let program = Address::new_unique();
    svm.add_program_from_file(program, &so).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let mut results = serde_json::Map::new();
    for (kind, name) in [(0u8, "spend"), (1, "insert"), (2, "exit")] {
        let c = &vectors["circuits"][name];
        let mut run = |case: &Value| {
            let ixs = [
                ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
                Instruction::new_with_bytes(program, &data(kind, case), vec![]),
            ];
            // A fresh blockhash per transaction keeps identical retries from being deduplicated.
            svm.expire_blockhash();
            let tx = Transaction::new(&[&payer], Message::new(&ixs, Some(&payer.pubkey())), svm.latest_blockhash());
            svm.send_transaction(tx)
        };
        let ok = run(&c["valid"]).unwrap_or_else(|e| panic!("{name}: valid proof failed: {:?}", e.err));
        for bad in c["invalid"].as_array().unwrap() {
            assert!(run(bad).is_err(), "{name}: {} accepted on-chain", bad["name"]);
        }
        // Subtract the compute-budget instruction (150 CU) to report the verifier instruction alone.
        let total = ok.compute_units_consumed;
        println!("{name}: {total} CU (transaction), data {} bytes", data(kind, &c["valid"]).len());
        results.insert(
            name.into(),
            json!({ "transactionComputeUnits": total, "verifierInstructionComputeUnits": total - 150, "instructionDataBytes": data(kind, &c["valid"]).len() }),
        );
    }
    let out = json!({
        "harness": "LiteSVM 0.17.0 (Agave 4.3 runtime), SBF build with platform-tools v1.57; one verify() per instruction",
        "zkeySha256": { "spend": vectors["circuits"]["spend"]["zkeySha256"], "insert": vectors["circuits"]["insert"]["zkeySha256"], "exit": vectors["circuits"]["exit"]["zkeySha256"] },
        "circuits": results,
    });
    std::fs::write(repo("artifacts/circuits/verifier-cu.json"), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
}
