//! snarkjs proofs from artifacts/vectors/groth16-v1.json verified with groth16-solana 0.2.0
//! `verify()` against the generated verifying keys, plus mutated proofs that must fail.

mod common;

use common::*;
use groth16_solana::errors::Groth16Error;
use serde_json::Value;
use veilo_crypto::{verify_exit, verify_insert, verify_spend, vk, Groth16Proof};

fn proof_of(c: &Value) -> Groth16Proof {
    Groth16Proof {
        a: hex(s(&c["a"])).try_into().expect("a: 64 bytes"),
        b: hex(s(&c["b"])).try_into().expect("b: 128 bytes"),
        c: hex(s(&c["c"])).try_into().expect("c: 64 bytes"),
    }
}

fn inputs_of<const N: usize>(c: &Value) -> [[u8; 32]; N] {
    let v: Vec<[u8; 32]> = c["publicInputs"].as_array().unwrap().iter().map(|x| hex32(s(x))).collect();
    v.try_into().expect("public input count")
}

fn run(name: &str, verify: impl Fn(&Groth16Proof, &Value) -> Result<(), Groth16Error>) {
    let all = load_json("artifacts/vectors/groth16-v1.json");
    let c = &all["circuits"][name];
    let manifest = load_json("artifacts/circuits/manifest.json");
    assert_eq!(
        s(&c["zkeySha256"]),
        s(&manifest["circuits"][name]["zkeySha256"]),
        "groth16 vectors were produced by another proving key"
    );
    verify(&proof_of(&c["valid"]), &c["valid"]).unwrap_or_else(|e| panic!("{name}: valid proof rejected: {e:?}"));
    for bad in c["invalid"].as_array().unwrap() {
        let err = verify(&proof_of(bad), bad).expect_err(s(&bad["name"]));
        assert_eq!(format!("{err:?}"), s(&bad["error"]), "{name}: {}", s(&bad["name"]));
    }
}

#[test]
fn spend_proofs() {
    run("spend", |p, c| verify_spend(p, &inputs_of::<{ vk::SPEND_NR_INPUTS }>(c)));
}

#[test]
fn insert_proofs() {
    run("insert", |p, c| verify_insert(p, &inputs_of::<{ vk::INSERT_NR_INPUTS }>(c)));
}

#[test]
fn exit_proofs() {
    run("exit", |p, c| verify_exit(p, &inputs_of::<{ vk::EXIT_NR_INPUTS }>(c)));
}

#[test]
fn proofs_do_not_cross_circuits() {
    let all = load_json("artifacts/vectors/groth16-v1.json");
    let exit = &all["circuits"]["exit"]["valid"];
    // Same input count (4): an exit proof must not verify under the insert key.
    assert!(verify_insert(&proof_of(exit), &inputs_of::<4>(exit)).is_err());
}

#[test]
fn generated_vk_files_match_manifest() {
    let manifest = load_json("artifacts/circuits/manifest.json");
    for name in ["spend", "insert", "exit"] {
        let bytes = std::fs::read(repo_path(&format!("programs/veilo-crypto/src/vk/{name}.rs"))).unwrap();
        let digest = solana_sha256_hasher::hash(&bytes).to_bytes();
        assert_eq!(to_hex(&digest), s(&manifest["circuits"][name]["vkRustSha256"]), "{name}.rs");
    }
    assert_eq!(vk::SPEND_VK.vk_ic.len(), vk::SPEND_NR_INPUTS + 1);
    assert_eq!(vk::INSERT_VK.vk_ic.len(), vk::INSERT_NR_INPUTS + 1);
    assert_eq!(vk::EXIT_VK.vk_ic.len(), vk::EXIT_NR_INPUTS + 1);
}
