//! Reproduces artifacts/vectors/v1.json with the Rust implementations the program uses
//! (solana-sha256-hasher, solana-poseidon) and with light-poseidon directly.

mod common;

use ark_bn254::Fr;
use common::*;
use light_poseidon::{Poseidon, PoseidonBytesHasher};
use serde_json::Value;
use solana_poseidon::{Endianness, Parameters};
use solana_pubkey::Pubkey;
use veilo_crypto::*;

fn vectors() -> Value {
    load_json("artifacts/vectors/v1.json")
}

fn light(inputs: &[[u8; 32]]) -> [u8; 32] {
    let refs: Vec<&[u8]> = inputs.iter().map(|x| x.as_slice()).collect();
    Poseidon::<Fr>::new_circom(inputs.len()).unwrap().hash_bytes_be(&refs).unwrap()
}

fn solana(inputs: &[[u8; 32]]) -> [u8; 32] {
    let refs: Vec<&[u8]> = inputs.iter().map(|x| x.as_slice()).collect();
    solana_poseidon::hashv(Parameters::Bn254X5, Endianness::BigEndian, &refs).unwrap().to_bytes()
}

/// Both Poseidon implementations must agree on every call.
fn h(inputs: &[[u8; 32]]) -> [u8; 32] {
    let a = light(inputs);
    assert_eq!(a, solana(inputs), "light-poseidon and solana-poseidon disagree");
    a
}

fn root_from_path(leaf: [u8; 32], index: u64, siblings: &[Value]) -> [u8; 32] {
    let mut cur = leaf;
    for (i, sib) in siblings.iter().enumerate() {
        let sib = dec32(s(sib));
        cur = if (index >> i) & 1 == 1 { h(&[sib, cur]) } else { h(&[cur, sib]) };
    }
    cur
}

#[test]
fn field_encodings() {
    let v = vectors();
    let f = &v["field"];
    assert_eq!(dec32(s(&f["r"])), FIELD_MODULUS_BE);
    assert_eq!(hex32(s(&f["rBe32"])), FIELD_MODULUS_BE);
    for c in f["canonical"].as_array().unwrap() {
        let be = hex32(s(&c["be32"]));
        assert_eq!(dec32(s(&c["value"])), be);
        assert!(is_canonical(&be));
        assert!(groth16_solana::groth16::is_less_than_bn254_field_size_be(&be));
    }
    for c in f["u64"].as_array().unwrap() {
        let x = u64v(&c["value"]);
        assert_eq!(to_hex(&x.to_be_bytes()), s(&c["be8"]));
        assert_eq!(to_hex(&x.to_le_bytes()), s(&c["le8"]));
        assert_eq!(to_hex(&u64_to_field(x)), s(&c["be32"]));
    }
    for c in f["nonCanonical"].as_array().unwrap() {
        let bytes = hex(s(&c["hex"]));
        match <[u8; 32]>::try_from(bytes.as_slice()) {
            Ok(b) => {
                assert!(!is_canonical(&b), "{}", s(&c["reason"]));
                assert!(!groth16_solana::groth16::is_less_than_bn254_field_size_be(&b));
                let err = Poseidon::<Fr>::new_circom(1).unwrap().hash_bytes_be(&[&b]);
                assert!(err.is_err(), "light-poseidon accepted {}", s(&c["reason"]));
            }
            Err(_) => {
                assert_ne!(bytes.len(), 32);
                let err = Poseidon::<Fr>::new_circom(1).unwrap().hash_bytes_be(&[&bytes]);
                assert!(err.is_err(), "light-poseidon accepted {}", s(&c["reason"]));
            }
        }
    }
}

#[test]
fn poseidon() {
    let v = vectors();
    for c in v["poseidon"].as_array().unwrap() {
        let inputs: Vec<[u8; 32]> = c["inputs"].as_array().unwrap().iter().map(|x| dec32(s(x))).collect();
        assert_eq!(inputs.len(), if s(&c["fn"]) == "H2" { 2 } else { 3 });
        assert_eq!(h(&inputs), dec32(s(&c["output"])), "{c}");
    }
}

#[test]
fn labels() {
    let v = vectors();
    for c in v["label"].as_array().unwrap() {
        let (pool, mint, refund, salt) =
            (hex32(s(&c["pool"])), hex32(s(&c["mint"])), hex32(s(&c["refundAuthority"])), hex32(s(&c["salt"])));
        let preimage = [LABEL_DOMAIN.as_slice(), &pool, &mint, &refund, &salt].concat();
        assert_eq!(preimage.len(), LABEL_PREIMAGE_LEN);
        assert_eq!(to_hex(&preimage), s(&c["preimage"]));
        assert_eq!(to_hex(&solana_sha256_hasher::hash(&preimage).to_bytes()), s(&c["sha256"]));
        let l = label(&pool, &mint, &refund, &salt);
        assert_eq!(to_hex(&l), s(&c["labelBe32"]));
        assert_eq!(l, dec32(s(&c["label"])));
        assert!(!is_zero(&l));
    }
}

fn opt32(v: &Value) -> Option<[u8; 32]> {
    v.as_str().map(hex32)
}

struct OwnedIntent {
    k: [[u8; 32]; 6],
    relayer: Option<[u8; 32]>,
    fee_account: Option<[u8; 32]>,
    payout: u64,
    fee: u64,
    valid_until: u64,
}

impl OwnedIntent {
    fn from(c: &Value) -> Self {
        let k = ["programId", "pool", "genesisHash", "mint", "destinationTokenAccount", "destinationOwner"]
            .map(|key| hex32(s(&c[key])));
        OwnedIntent {
            k,
            relayer: opt32(&c["relayer"]),
            fee_account: opt32(&c["relayerFeeTokenAccount"]),
            payout: u64v(&c["payoutAmount"]),
            fee: u64v(&c["relayerFee"]),
            valid_until: u64v(&c["validUntilSlot"]),
        }
    }

    fn fields(&self) -> IntentFields<'_> {
        IntentFields {
            program_id: &self.k[0],
            pool: &self.k[1],
            genesis_hash: &self.k[2],
            mint: &self.k[3],
            destination_token_account: &self.k[4],
            destination_owner: &self.k[5],
            payout_amount: self.payout,
            relayer_fee: self.fee,
            relayer: self.relayer.as_ref(),
            relayer_fee_token_account: self.fee_account.as_ref(),
            valid_until_slot: self.valid_until,
        }
    }
}

#[test]
fn intents() {
    let v = vectors();
    for c in v["intent"]["valid"].as_array().unwrap() {
        let owned = OwnedIntent::from(c);
        let i = owned.fields();
        let bytes = intent_bytes(&i);
        assert_eq!(to_hex(&bytes), s(&c["intentBytes"]), "{}", s(&c["name"]));
        assert_eq!(to_hex(&solana_sha256_hasher::hash(&bytes).to_bytes()), s(&c["sha256"]));
        assert_eq!(to_hex(&intent_context(&i)), s(&c["contextBe32"]));
        assert_eq!(intent_context(&i), dec32(s(&c["context"])));
        assert_eq!(withdrawn_value(&i), Some(u64v(&c["withdrawnValue"])));
    }
    for c in v["intent"]["invalid"].as_array().unwrap() {
        let owned = OwnedIntent::from(c);
        let err = check_intent(&owned.fields(), u64v(&c["maxRelayerFee"]), u64v(&c["currentSlot"]))
            .expect_err(s(&c["name"]));
        assert_eq!(format!("{err:?}"), s(&c["error"]), "{}", s(&c["name"]));
    }
    let b = &v["intent"]["boundary"];
    for slot in b["acceptedCurrentSlots"].as_array().unwrap() {
        let first = &v["intent"]["valid"][0];
        let owned = OwnedIntent::from(first);
        assert_eq!(owned.valid_until, u64v(&b["validUntilSlot"]));
        assert!(check_intent(&owned.fields(), 0, u64v(slot)).is_ok());
    }
}

fn check_note(n: &Value) {
    let (value, label_, nsec, sec) =
        (u64v(&n["value"]), dec32(s(&n["label"])), dec32(s(&n["nullifierSecret"])), dec32(s(&n["noteSecret"])));
    let pre = h(&[nsec, sec]);
    assert_eq!(pre, dec32(s(&n["precommitment"])));
    let c = h(&[u64_to_field(value), label_, pre]);
    assert_eq!(c, dec32(s(&n["commitment"])));
    assert_eq!(deposit_commitment(value, &label_, &pre).unwrap(), c);
    assert_eq!(h(&[nsec, label_]), dec32(s(&n["nullifierHash"])));
}

#[test]
fn notes() {
    let v = vectors();
    for n in v["note"].as_array().unwrap() {
        check_note(n);
        for ch in n["changes"].as_array().unwrap() {
            check_note(ch);
            assert_eq!(s(&ch["label"]), s(&n["label"]), "change keeps the label");
            assert_eq!(u64v(&ch["value"]), u64v(&n["value"]) - u64v(&ch["withdrawn"]));
        }
    }
}

#[test]
fn zeros_and_empty_root() {
    let v = vectors();
    let zeros = v["zeros"].as_array().unwrap();
    assert_eq!(zeros.len(), TREE_DEPTH + 1);
    let mut z = [0u8; 32];
    assert_eq!(dec32(s(&zeros[0])), z);
    for zi in &zeros[1..] {
        z = h(&[z, z]);
        assert_eq!(z, dec32(s(zi)));
    }
    assert_eq!(EMPTY_ROOT, z);
    assert_eq!(to_hex(&EMPTY_ROOT), s(&v["emptyRootBe32"]));
}

fn full_root(leaves: &[Value]) -> [u8; 32] {
    let mut level: Vec<[u8; 32]> = leaves.iter().map(|x| dec32(s(x))).collect();
    let mut zero = [0u8; 32];
    for _ in 0..TREE_DEPTH {
        if level.len() % 2 == 1 {
            level.push(zero);
        }
        level = level.chunks(2).map(|p| h(&[p[0], p[1]])).collect();
        zero = h(&[zero, zero]);
    }
    level[0]
}

#[test]
fn merkle_paths() {
    let v = vectors();
    for tree in ["state", "approved"] {
        let t = &v["merkle"][tree];
        let root = dec32(s(&t["root"]));
        assert_eq!(full_root(t["leaves"].as_array().unwrap()), root);
        for p in t["paths"].as_array().unwrap() {
            let index = p["index"].as_u64().unwrap();
            let bits: Vec<u64> = p["pathBits"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap()).collect();
            assert_eq!(bits, (0..TREE_DEPTH).map(|i| (index >> i) & 1).collect::<Vec<_>>());
            assert_eq!(root_from_path(dec32(s(&p["leaf"])), index, p["siblings"].as_array().unwrap()), root);
        }
    }
}

#[test]
fn insert_sequence() {
    let v = vectors();
    let mut root = EMPTY_ROOT;
    let mut next_index = 0u64;
    for step in v["insert"].as_array().unwrap() {
        if step["skipped"].as_bool().unwrap() {
            assert_eq!(dec32(s(&step["root"])), root, "skip leaves the root unchanged");
            assert_eq!(step["nextLeafIndex"].as_u64().unwrap(), next_index);
            continue;
        }
        let index = step["leafIndex"].as_u64().unwrap();
        assert_eq!(index, next_index);
        let sibs = step["siblings"].as_array().unwrap();
        assert_eq!(dec32(s(&step["oldRoot"])), root);
        assert_eq!(root_from_path([0u8; 32], index, sibs), root);
        let new_root = root_from_path(dec32(s(&step["leaf"])), index, sibs);
        assert_eq!(new_root, dec32(s(&step["newRoot"])));
        root = new_root;
        next_index += 1;
    }
}

#[test]
fn pdas() {
    let v = vectors();
    let p = &v["pda"];
    let program = Pubkey::new_from_array(hex32(s(&p["programIdHex"])));
    assert_eq!(program.to_string(), s(&p["programId"]));
    let check = |seeds: &[&[u8]], owner: &Pubkey, expected: &Value| -> Pubkey {
        let (addr, bump) = Pubkey::find_program_address(seeds, owner);
        assert_eq!(addr.to_string(), s(&expected["address"]));
        assert_eq!(bump as u64, expected["bump"].as_u64().unwrap());
        addr
    };
    let pool = check(&[b"pool", &hex32(s(&p["poolId"]))], &program, &p["poolState"]);
    let va = check(&[b"vault_authority", pool.as_ref()], &program, &p["vaultAuthority"]);
    check(&[b"approval", pool.as_ref()], &program, &p["approvalState"]);
    for d in p["pendingDeposit"].as_array().unwrap() {
        check(&[b"deposit", pool.as_ref(), &u64v(&d["queueSeq"]).to_le_bytes()], &program, d);
    }
    let sp = &p["seenPrecommitment"];
    check(&[b"precommitment", pool.as_ref(), &hex32(s(&sp["precommitment"]))], &program, sp);
    let pc = &p["pendingChange"];
    check(&[b"change", pool.as_ref(), &hex32(s(&pc["nullifierHash"]))], &program, pc);
    let sn = &p["spentNullifier"];
    check(&[b"nullifier", pool.as_ref(), &hex32(s(&sn["nullifierHash"]))], &program, sn);
    let token: Pubkey = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".parse().unwrap();
    let ata: Pubkey = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".parse().unwrap();
    let mint: Pubkey = s(&p["mint"]).parse().unwrap();
    check(&[va.as_ref(), token.as_ref(), mint.as_ref()], &ata, &p["vault"]);
}
