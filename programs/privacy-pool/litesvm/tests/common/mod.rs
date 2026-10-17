//! Harness: loads the localnet program build into LiteSVM, replays the fixture scenario from
//! scripts/program-fixtures.ts and builds instructions in the protocol's account order.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::{v0, AddressLookupTableAccount, Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const LOADER_V3: Address = Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
pub const MAINNET_GENESIS: [u8; 32] = [
    0x45, 0x29, 0x69, 0x98, 0xa6, 0xf8, 0xe2, 0xa7, 0x84, 0xdb, 0x5d, 0x9f, 0x95, 0xe1, 0x8f, 0xc2, 0x3f, 0x70, 0x44,
    0x1a, 0x10, 0x39, 0x44, 0x68, 0x01, 0x08, 0x98, 0x79, 0xb0, 0x8c, 0x7e, 0xf0,
];
/// be32(r)
pub const R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8,
    0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Protocol error codes (section 8.7), numbered from 6000.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum E {
    NonCanonicalFieldElement = 6000,
    ZeroValueNotAllowed,
    ZeroLabel,
    ZeroCommitment,
    InvalidGenesis,
    InvalidMint,
    InvalidTokenProgram,
    InvalidTokenAccount,
    InvalidVault,
    InvalidDestination,
    PoolMismatch,
    Unauthorized,
    NotUpgradeAuthority,
    DepositsPaused,
    DepositBelowMinimum,
    DepositAboveMaximum,
    LiabilityCapExceeded,
    TreeCapacityExhausted,
    QueueFull,
    TransferAmountMismatch,
    DepositNotPending,
    InvalidQueueItem,
    NotQueueHead,
    QueueItemNotPending,
    QueueItemNotRefunded,
    UnknownStateRoot,
    InvalidProof,
    PayoutZero,
    AmountOverflow,
    RelayerMismatch,
    RelayerFeeNotAllowed,
    RelayerFeeAccountMismatch,
    IntentExpired,
    IntentTooFarInFuture,
    LiabilityUnderflow,
    ConfigOutOfBounds,
}

/// Anchor framework error codes used by the tests.
pub const ANCHOR_CONSTRAINT_SEEDS: u32 = 2006;
pub const ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;
/// System Program `AccountAlreadyInUse`.
pub const SYSTEM_ALREADY_IN_USE: u32 = 0;

pub fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(rel)
}

pub fn hexv(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

pub fn h32(s: &str) -> [u8; 32] {
    hexv(s).try_into().unwrap()
}

pub fn addr(s: &str) -> Address {
    Address::new_from_array(h32(s))
}

pub fn u64v(v: &Value) -> u64 {
    v.as_str().map(|s| s.parse().unwrap()).unwrap_or_else(|| v.as_u64().unwrap())
}

pub fn disc(namespace: &str, name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("{namespace}:{name}").as_bytes());
    h[..8].try_into().unwrap()
}

/// x + 1 as a 32-byte big-endian integer (used to perturb public inputs).
pub fn plus_one(x: &[u8; 32]) -> [u8; 32] {
    let mut out = *x;
    for i in (0..32).rev() {
        let (v, carry) = out[i].overflowing_add(1);
        out[i] = v;
        if !carry {
            break;
        }
    }
    out
}

/// x + r, which is the same field element but not canonical.
pub fn plus_r(x: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let s = x[i] as u16 + R[i] as u16 + carry;
        out[i] = s as u8;
        carry = s >> 8;
    }
    assert_eq!(carry, 0);
    out
}

pub fn custom_code(r: &TxResult) -> Option<u32> {
    match r {
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        },
        Ok(_) => None,
    }
}

#[track_caller]
pub fn ok(r: TxResult) -> TransactionMetadata {
    match r {
        Ok(m) => m,
        Err(f) => panic!("transaction failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

#[track_caller]
pub fn fails(r: &TxResult, e: E) {
    assert_eq!(custom_code(r), Some(e as u32), "expected {e:?}, got {}", describe(r));
}

#[track_caller]
pub fn fails_code(r: &TxResult, code: u32) {
    assert_eq!(custom_code(r), Some(code), "expected custom {code}, got {}", describe(r));
}

/// The System Program refused to create an account that already exists (replay rejection).
#[track_caller]
pub fn fails_already_in_use(r: &TxResult) {
    fails_code(r, SYSTEM_ALREADY_IN_USE);
    let logs = &r.as_ref().unwrap_err().meta.logs;
    assert!(logs.iter().any(|l| l.contains("already in use")), "{}", logs.join("\n"));
}

pub fn describe(r: &TxResult) -> String {
    match r {
        Ok(_) => "success".into(),
        Err(f) => format!("{:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

pub fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

pub fn ata(owner: &Address, mint: &Address) -> Address {
    pda(&[owner.as_ref(), TOKEN.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}

pub fn token_account_data(mint: &Address, owner: &Address, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    d
}

pub fn mint_data(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[36..44].copy_from_slice(&1_000_000_000_000u64.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}

#[derive(Clone, Copy)]
pub enum Record {
    Deposit(u64),
    Change([u8; 32]),
}

pub struct Proof {
    pub a: Vec<u8>,
    pub b: Vec<u8>,
    pub c: Vec<u8>,
}

impl Proof {
    pub fn from(v: &Value) -> Self {
        Proof { a: hexv(v["a"].as_str().unwrap()), b: hexv(v["b"].as_str().unwrap()), c: hexv(v["c"].as_str().unwrap()) }
    }
    pub fn bytes(&self) -> Vec<u8> {
        [self.a.clone(), self.b.clone(), self.c.clone()].concat()
    }
}

#[derive(Clone)]
pub struct Intent {
    pub destination_token_account: Address,
    pub destination_owner: Address,
    pub payout: u64,
    pub fee: u64,
    pub relayer: Option<Address>,
    pub fee_account: Option<Address>,
    pub valid_until_slot: u64,
}

impl Intent {
    pub fn from(v: &Value) -> Self {
        let opt = |x: &Value| x.as_str().map(addr);
        Intent {
            destination_token_account: addr(v["destinationTokenAccount"].as_str().unwrap()),
            destination_owner: addr(v["destinationOwner"].as_str().unwrap()),
            payout: u64v(&v["payoutAmount"]),
            fee: u64v(&v["relayerFee"]),
            relayer: opt(&v["relayer"]),
            fee_account: opt(&v["relayerFeeTokenAccount"]),
            valid_until_slot: u64v(&v["validUntilSlot"]),
        }
    }
    pub fn borsh(&self) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(self.destination_token_account.as_ref());
        d.extend_from_slice(self.destination_owner.as_ref());
        d.extend_from_slice(&self.payout.to_le_bytes());
        d.extend_from_slice(&self.fee.to_le_bytes());
        for o in [self.relayer, self.fee_account] {
            match o {
                None => d.push(0),
                Some(k) => {
                    d.push(1);
                    d.extend_from_slice(k.as_ref());
                }
            }
        }
        d.extend_from_slice(&self.valid_until_slot.to_le_bytes());
        d
    }
}

pub struct SpendArgs {
    pub proof: Proof,
    pub state_root: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub new_commitment: [u8; 32],
    pub intent: Intent,
}

pub struct ExitArgs {
    pub proof: Proof,
    pub state_root: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub value: u64,
    pub salt: [u8; 32],
    pub owner: String,
}

pub struct Pool {
    pub id: [u8; 32],
    pub state: Address,
    pub vault_authority: Address,
    pub vault: Address,
    pub approval: Address,
}

pub struct Env {
    pub svm: LiteSVM,
    pub fx: Value,
    pub program: Address,
    pub mint: Address,
    pub keys: HashMap<String, Keypair>,
    pub pools: HashMap<String, Pool>,
    /// (instruction, compute units, transaction bytes) of successful sends.
    pub log: Vec<(String, u64, usize)>,
}

pub fn fixtures() -> Value {
    let path = std::env::var("VEILO_POOL_FIXTURES").map(PathBuf::from).unwrap_or_else(|_| repo("target/program-fixtures/fixtures.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}; run scripts/program-fixtures.ts", path.display()))).unwrap()
}

pub fn program_so() -> Vec<u8> {
    let path = std::env::var("VEILO_POOL_SO").expect("VEILO_POOL_SO points at the localnet program build");
    std::fs::read(path).unwrap()
}

impl Env {
    pub fn new() -> Self {
        let fx = fixtures();
        let program = addr(fx["programId"].as_str().unwrap());
        let mut svm = LiteSVM::new();
        svm.add_program(program, &program_so()).unwrap();

        let mut keys = HashMap::new();
        for (name, k) in fx["keys"].as_object().unwrap() {
            let kp = Keypair::new_from_array(h32(k["seed"].as_str().unwrap()));
            assert_eq!(kp.pubkey(), addr(k["address"].as_str().unwrap()), "{name}: fixture key mismatch");
            svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
            keys.insert(name.clone(), kp);
        }
        let mint = addr(fx["mint"]["address"].as_str().unwrap());
        let mut env = Env { svm, fx, program, mint, keys, pools: HashMap::new(), log: Vec::new() };
        env.set_upgrade_authority(Some(env.key("deployer")));
        env.put_account(mint, TOKEN, mint_data(6));
        for (name, amount) in [("alice", 50_000_000), ("bob", 50_000_000), ("carol", 50_000_000), ("dave", 50_000_000), ("mallory", 200_000_000)] {
            let owner = env.key(name);
            env.put_account(ata(&owner, &mint), TOKEN, token_account_data(&mint, &owner, amount));
        }
        // Fresh payment wallets and the relayer start with empty exact-mint ATAs.
        for name in ["w1", "w2", "w3", "relayer"] {
            let owner = env.key(name);
            env.put_account(ata(&owner, &mint), TOKEN, token_account_data(&mint, &owner, 0));
        }
        for p in ["A", "B"] {
            let id = h32(env.fx["pools"][p]["poolId"].as_str().unwrap());
            let state = pda(&[b"pool", &id], &program);
            assert_eq!(state, addr(env.fx["pools"][p]["pool"].as_str().unwrap()));
            let vault_authority = pda(&[b"vault_authority", state.as_ref()], &program);
            let vault = ata(&vault_authority, &mint);
            let approval = pda(&[b"approval", state.as_ref()], &program);
            env.pools.insert(p.into(), Pool { id, state, vault_authority, vault, approval });
        }
        env
    }

    pub fn key(&self, name: &str) -> Address {
        self.keys[name].pubkey()
    }

    pub fn kp(&self, name: &str) -> &Keypair {
        &self.keys[name]
    }

    pub fn pool(&self, p: &str) -> &Pool {
        &self.pools[p]
    }

    pub fn put_account(&mut self, address: Address, owner: Address, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    pub fn account(&self, a: &Address) -> Option<Account> {
        self.svm.get_account(a).filter(|x| x.lamports > 0)
    }

    pub fn set_upgrade_authority(&mut self, authority: Option<Address>) {
        let pd = pda(&[self.program.as_ref()], &LOADER_V3);
        let mut acc = self.svm.get_account(&pd).unwrap();
        acc.data[12] = authority.is_some() as u8;
        acc.data[13..45].copy_from_slice(authority.map(|a| a.to_bytes()).unwrap_or_default().as_ref());
        self.svm.set_account(pd, acc).unwrap();
    }

    pub fn token_balance(&self, a: &Address) -> u64 {
        u64::from_le_bytes(self.svm.get_account(a).unwrap().data[64..72].try_into().unwrap())
    }

    pub fn ata_of(&self, name: &str) -> Address {
        ata(&self.key(name), &self.mint)
    }

    // --- sending ---

    /// Signs with the sponsor `payer` plus `signers`, with a fresh blockhash so that a resend is a
    /// new transaction rather than a deduplicated replay.
    pub fn send(&mut self, label: &str, ixs: Vec<Instruction>, signers: &[&str]) -> TxResult {
        self.send_with_limit(label, ixs, signers, 1_400_000)
    }

    pub fn send_with_limit(&mut self, label: &str, ixs: Vec<Instruction>, signers: &[&str], cu_limit: u32) -> TxResult {
        self.svm.expire_blockhash();
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(cu_limit)];
        all.extend(ixs);
        let payer = self.key("payer");
        let mut kps: Vec<&Keypair> = vec![&self.keys["payer"]];
        for s in signers {
            if *s != "payer" {
                kps.push(&self.keys[*s]);
            }
        }
        let tx = Transaction::new(&kps, Message::new(&all, Some(&payer)), self.svm.latest_blockhash());
        let size = bincode::serialize(&tx).unwrap().len();
        let r = self.svm.send_transaction(tx);
        if let Ok(m) = &r {
            self.log.push((label.into(), m.compute_units_consumed, size));
        }
        r
    }

    /// Same as `send` but as a v0 transaction resolving accounts through `table`.
    pub fn send_v0(&mut self, label: &str, ixs: Vec<Instruction>, signers: &[&str], table: &AddressLookupTableAccount) -> (TxResult, usize) {
        self.svm.expire_blockhash();
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend(ixs);
        let payer = self.key("payer");
        let msg = v0::Message::try_compile(&payer, &all, std::slice::from_ref(table), self.svm.latest_blockhash()).unwrap();
        let mut kps: Vec<&Keypair> = vec![&self.keys["payer"]];
        for s in signers {
            if *s != "payer" {
                kps.push(&self.keys[*s]);
            }
        }
        let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &kps).unwrap();
        let size = bincode::serialize(&tx).unwrap().len();
        let r = self.svm.send_transaction(tx);
        if let Ok(m) = &r {
            self.log.push((label.into(), m.compute_units_consumed, size));
        }
        (r, size)
    }

    /// Installs an active address lookup table holding `addresses`.
    pub fn put_lookup_table(&mut self, table: Address, addresses: &[Address]) -> AddressLookupTableAccount {
        let mut d = Vec::new();
        d.extend_from_slice(&1u32.to_le_bytes());
        d.extend_from_slice(&u64::MAX.to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes());
        d.push(0);
        d.push(0);
        d.extend_from_slice(&[0u8; 32]);
        d.extend_from_slice(&[0u8; 2]);
        assert_eq!(d.len(), 56);
        for a in addresses {
            d.extend_from_slice(a.as_ref());
        }
        let alt_program = Address::from_str_const("AddressLookupTab1e1111111111111111111111111");
        self.put_account(table, alt_program, d);
        AddressLookupTableAccount { key: table, addresses: addresses.to_vec() }
    }

    // --- instruction builders (account order per docs/protocol.md section 8.4) ---

    fn ix(&self, name: &str, accounts: Vec<AccountMeta>, args: &[u8]) -> Instruction {
        let mut data = disc("global", name).to_vec();
        data.extend_from_slice(args);
        Instruction { program_id: self.program, accounts, data }
    }

    fn optional(&self, a: Option<Address>) -> AccountMeta {
        match a {
            Some(a) => AccountMeta::new(a, false),
            None => AccountMeta::new_readonly(self.program, false),
        }
    }

    pub fn ix_initialize(&self, p: &str, deployer: &str, genesis: [u8; 32], decimals: u8) -> Instruction {
        self.ix_initialize_with(p, deployer, genesis, decimals, self.mint, TOKEN)
    }

    pub fn ix_initialize_with(&self, p: &str, deployer: &str, genesis: [u8; 32], decimals: u8, mint: Address, token_program: Address) -> Instruction {
        let pool = self.pool(p);
        let vault = ata(&pool.vault_authority, &mint);
        let mut args = pool.id.to_vec();
        args.extend_from_slice(&genesis);
        args.push(decimals);
        args.extend_from_slice(self.key("approver").as_ref());
        args.extend_from_slice(self.key("config").as_ref());
        self.ix(
            "initialize_pool",
            vec![
                AccountMeta::new(self.key(deployer), true),
                AccountMeta::new_readonly(pda(&[self.program.as_ref()], &LOADER_V3), false),
                AccountMeta::new(pool.state, false),
                AccountMeta::new_readonly(pool.vault_authority, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(pool.approval, false),
                AccountMeta::new_readonly(token_program, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            &args,
        )
    }

    pub fn genesis(&self) -> [u8; 32] {
        h32(self.fx["genesis"].as_str().unwrap())
    }

    pub fn init_pool(&mut self, p: &str) {
        let ix = self.ix_initialize(p, "deployer", self.genesis(), 6);
        ok(self.send("initialize_pool", vec![ix], &["deployer"]));
    }

    pub fn deposit_pda(&self, p: &str, seq: u64) -> Address {
        pda(&[b"deposit", self.pool(p).state.as_ref(), &seq.to_le_bytes()], &self.program)
    }

    pub fn seen_pda(&self, p: &str, pre: &[u8; 32]) -> Address {
        pda(&[b"precommitment", self.pool(p).state.as_ref(), pre], &self.program)
    }

    pub fn nullifier_pda(&self, p: &str, nf: &[u8; 32]) -> Address {
        pda(&[b"nullifier", self.pool(p).state.as_ref(), nf], &self.program)
    }

    pub fn change_pda(&self, p: &str, nf: &[u8; 32]) -> Address {
        pda(&[b"change", self.pool(p).state.as_ref(), nf], &self.program)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_deposit_raw(
        &self,
        p: &str,
        depositor: &str,
        source: Address,
        vault: Address,
        seq: u64,
        amount: u64,
        pre: [u8; 32],
        salt: [u8; 32],
        token_program: Address,
    ) -> Instruction {
        let pool = self.pool(p);
        let mut args = amount.to_le_bytes().to_vec();
        args.extend_from_slice(&pre);
        args.extend_from_slice(&salt);
        self.ix(
            "deposit",
            vec![
                AccountMeta::new_readonly(self.key(depositor), true),
                AccountMeta::new(self.key("payer"), true),
                AccountMeta::new(pool.state, false),
                AccountMeta::new(source, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(self.deposit_pda(p, seq), false),
                AccountMeta::new(self.seen_pda(p, &pre), false),
                AccountMeta::new_readonly(token_program, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            &args,
        )
    }

    pub fn ix_deposit(&self, p: &str, depositor: &str, seq: u64, amount: u64, pre: [u8; 32], salt: [u8; 32]) -> Instruction {
        let source = self.ata_of(depositor);
        let vault = self.pool(p).vault;
        self.ix_deposit_raw(p, depositor, source, vault, seq, amount, pre, salt, TOKEN)
    }

    pub fn fixture_deposit(&self, name: &str) -> (String, u64, u64, [u8; 32], [u8; 32]) {
        let d = self.fx["deposits"].as_array().unwrap().iter().find(|d| d["name"] == name).unwrap();
        (
            d["owner"].as_str().unwrap().to_string(),
            d["seq"].as_u64().unwrap(),
            u64v(&d["amount"]),
            h32(d["precommitment"].as_str().unwrap()),
            h32(d["salt"].as_str().unwrap()),
        )
    }

    pub fn deposit(&mut self, name: &str) -> TxResult {
        let (owner, seq, amount, pre, salt) = self.fixture_deposit(name);
        let ix = self.ix_deposit("A", &owner, seq, amount, pre, salt);
        self.send("deposit", vec![ix], &[&owner])
    }

    pub fn ix_refund(&self, p: &str, signer: &str, seq: u64, destination: Address) -> Instruction {
        let pool = self.pool(p);
        self.ix(
            "refund_pending_deposit",
            vec![
                AccountMeta::new_readonly(self.key(signer), true),
                AccountMeta::new(pool.state, false),
                AccountMeta::new(self.deposit_pda(p, seq), false),
                AccountMeta::new(pool.vault, false),
                AccountMeta::new_readonly(pool.vault_authority, false),
                AccountMeta::new(destination, false),
                AccountMeta::new_readonly(TOKEN, false),
            ],
            &[],
        )
    }

    pub fn ix_insert_raw(&self, p: &str, deposit: Option<Address>, change: Option<Address>, proof: &Proof, new_root: [u8; 32]) -> Instruction {
        let pool = self.pool(p);
        let mut args = proof.bytes();
        args.extend_from_slice(&new_root);
        self.ix(
            "insert_leaf",
            vec![
                AccountMeta::new_readonly(self.key("payer"), true),
                AccountMeta::new(pool.state, false),
                self.optional(deposit),
                self.optional(change),
            ],
            &args,
        )
    }

    pub fn ix_insert(&self, proof_name: &str, record: Record) -> Instruction {
        let f = &self.fx["inserts"][proof_name];
        let proof = Proof::from(&f["proof"]);
        let new_root = h32(f["newRoot"].as_str().unwrap());
        match record {
            Record::Deposit(seq) => self.ix_insert_raw("A", Some(self.deposit_pda("A", seq)), None, &proof, new_root),
            Record::Change(nf) => self.ix_insert_raw("A", None, Some(self.change_pda("A", &nf)), &proof, new_root),
        }
    }

    pub fn insert(&mut self, proof_name: &str, record: Record) -> TxResult {
        let ix = self.ix_insert(proof_name, record);
        self.send("insert_leaf", vec![ix], &[])
    }

    pub fn ix_skip(&self, p: &str, seq: u64) -> Instruction {
        let pool = self.pool(p);
        self.ix(
            "skip_refunded_deposit",
            vec![
                AccountMeta::new_readonly(self.key("payer"), true),
                AccountMeta::new(pool.state, false),
                AccountMeta::new(self.deposit_pda(p, seq), false),
            ],
            &[],
        )
    }

    pub fn ix_approve(&self, p: &str, signer: &str, root: [u8; 32]) -> Instruction {
        let pool = self.pool(p);
        self.ix(
            "update_approved_root",
            vec![
                AccountMeta::new_readonly(self.key(signer), true),
                AccountMeta::new_readonly(pool.state, false),
                AccountMeta::new(pool.approval, false),
            ],
            &root,
        )
    }

    pub fn approved_root(&self, name: &str) -> [u8; 32] {
        h32(self.fx["approvedRoots"][name].as_str().unwrap())
    }

    pub fn root(&self, name: &str) -> [u8; 32] {
        h32(self.fx["roots"][name].as_str().unwrap())
    }

    pub fn approve(&mut self, name: &str) -> TxResult {
        let ix = self.ix_approve("A", "approver", self.approved_root(name));
        self.send("update_approved_root", vec![ix], &["approver"])
    }

    pub fn spend_args(&self, name: &str) -> SpendArgs {
        let f = &self.fx["spends"][name];
        SpendArgs {
            proof: Proof::from(&f["proof"]),
            state_root: h32(f["stateRoot"].as_str().unwrap()),
            nullifier_hash: h32(f["nullifierHash"].as_str().unwrap()),
            new_commitment: h32(f["newCommitment"].as_str().unwrap()),
            intent: Intent::from(&f["intent"]),
        }
    }

    /// Spend instruction; `relayer` is the signer placed in the relayer slot (None = absent).
    pub fn ix_spend(&self, p: &str, s: &SpendArgs, relayer: Option<Address>) -> Instruction {
        self.ix_spend_with(p, s, relayer, s.intent.fee_account, self.pool(p).approval, self.pool(p).vault, TOKEN)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_spend_with(
        &self,
        p: &str,
        s: &SpendArgs,
        relayer: Option<Address>,
        fee_account: Option<Address>,
        approval: Address,
        vault: Address,
        token_program: Address,
    ) -> Instruction {
        let pool = self.pool(p);
        let mut args = s.proof.bytes();
        args.extend_from_slice(&s.state_root);
        args.extend_from_slice(&s.nullifier_hash);
        args.extend_from_slice(&s.new_commitment);
        args.extend_from_slice(&s.intent.borsh());
        let relayer_meta = match relayer {
            Some(r) => AccountMeta::new_readonly(r, true),
            None => AccountMeta::new_readonly(self.program, false),
        };
        self.ix(
            "spend_private",
            vec![
                AccountMeta::new(self.key("payer"), true),
                relayer_meta,
                AccountMeta::new(pool.state, false),
                AccountMeta::new_readonly(approval, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(pool.vault_authority, false),
                AccountMeta::new(s.intent.destination_token_account, false),
                self.optional(fee_account),
                AccountMeta::new(self.nullifier_pda(p, &s.nullifier_hash), false),
                AccountMeta::new(self.change_pda(p, &s.nullifier_hash), false),
                AccountMeta::new_readonly(token_program, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            &args,
        )
    }

    /// Sends a fixture spend with the relayer its intent names (if any) signing.
    pub fn spend(&mut self, name: &str) -> TxResult {
        let s = self.spend_args(name);
        let relayer_name = s.intent.relayer.map(|r| self.name_of(&r));
        let ix = self.ix_spend("A", &s, s.intent.relayer);
        let signers: Vec<&str> = relayer_name.iter().map(|s| s.as_str()).collect();
        self.send("spend_private", vec![ix], &signers)
    }

    pub fn name_of(&self, a: &Address) -> String {
        self.keys.iter().find(|(_, k)| k.pubkey() == *a).map(|(n, _)| n.clone()).unwrap()
    }

    pub fn exit_args(&self, name: &str) -> ExitArgs {
        let f = &self.fx["exits"][name];
        ExitArgs {
            proof: Proof::from(&f["proof"]),
            state_root: h32(f["stateRoot"].as_str().unwrap()),
            nullifier_hash: h32(f["nullifierHash"].as_str().unwrap()),
            value: u64v(&f["value"]),
            salt: h32(f["salt"].as_str().unwrap()),
            owner: f["owner"].as_str().unwrap().to_string(),
        }
    }

    pub fn ix_exit(&self, p: &str, e: &ExitArgs, signer: &str, destination: Address) -> Instruction {
        let pool = self.pool(p);
        let mut args = e.proof.bytes();
        args.extend_from_slice(&e.state_root);
        args.extend_from_slice(&e.nullifier_hash);
        args.extend_from_slice(&e.value.to_le_bytes());
        args.extend_from_slice(&e.salt);
        self.ix(
            "exit_public",
            vec![
                AccountMeta::new_readonly(self.key(signer), true),
                AccountMeta::new(self.key("payer"), true),
                AccountMeta::new(pool.state, false),
                AccountMeta::new(pool.vault, false),
                AccountMeta::new_readonly(pool.vault_authority, false),
                AccountMeta::new(destination, false),
                AccountMeta::new(self.nullifier_pda(p, &e.nullifier_hash), false),
                AccountMeta::new_readonly(TOKEN, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            &args,
        )
    }

    pub fn exit(&mut self, name: &str) -> TxResult {
        let e = self.exit_args(name);
        let ix = self.ix_exit("A", &e, &e.owner, self.ata_of(&e.owner));
        let owner = e.owner.clone();
        self.send("exit_public", vec![ix], &[&owner])
    }

    pub fn ix_config(&self, p: &str, signer: &str, paused: Option<bool>, min: Option<u64>, max: Option<u64>, cap: Option<u64>, fee: Option<u64>) -> Instruction {
        let mut args = Vec::new();
        match paused {
            None => args.push(0),
            Some(b) => args.extend_from_slice(&[1, b as u8]),
        }
        for v in [min, max, cap, fee] {
            match v {
                None => args.push(0),
                Some(x) => {
                    args.push(1);
                    args.extend_from_slice(&x.to_le_bytes());
                }
            }
        }
        self.ix(
            "update_config",
            vec![AccountMeta::new_readonly(self.key(signer), true), AccountMeta::new(self.pool(p).state, false)],
            &args,
        )
    }

    pub fn config(&mut self, paused: Option<bool>, min: Option<u64>, max: Option<u64>, cap: Option<u64>, fee: Option<u64>) -> TxResult {
        let ix = self.ix_config("A", "config", paused, min, max, cap, fee);
        self.send("update_config", vec![ix], &["config"])
    }

    // --- account views (offsets include the 8-byte discriminator) ---

    pub fn pool_state(&self, p: &str) -> PoolView {
        PoolView(self.svm.get_account(&self.pool(p).state).unwrap().data)
    }

    pub fn snapshot(&self, addrs: &[Address]) -> Vec<Option<Account>> {
        addrs.iter().map(|a| self.account(a)).collect()
    }

    // --- scenario ---

    /// Replays the pool A timeline up to and including `stage`.
    pub fn advance(&mut self, stage: Stage) {
        for s in Stage::ALL {
            if s > stage {
                break;
            }
            self.run_stage(s);
        }
    }

    fn run_stage(&mut self, s: Stage) {
        match s {
            Stage::Initialized => self.init_pool("A"),
            Stage::Deposited => {
                for d in ["alice", "bob", "carol", "dave"] {
                    ok(self.deposit(d));
                }
            }
            Stage::TwoInserted => {
                ok(self.insert("alice", Record::Deposit(0)));
                ok(self.insert("bob", Record::Deposit(1)));
            }
            Stage::CarolRefundedAndSkipped => {
                let ix = self.ix_refund("A", "carol", 2, self.ata_of("carol"));
                ok(self.send("refund_pending_deposit", vec![ix], &["carol"]));
                let ix = self.ix_skip("A", 2);
                ok(self.send("skip_refunded_deposit", vec![ix], &[]));
            }
            Stage::DaveInserted => {
                ok(self.insert("dave", Record::Deposit(3)));
            }
            Stage::Approved => {
                ok(self.approve("RA"));
                let slot = u64v(&self.fx["spendSlot"]);
                self.svm.warp_to_slot(slot);
            }
            Stage::Spent0 => {
                ok(self.spend("alice_0"));
            }
            Stage::Change0Inserted => {
                let nf = self.spend_args("alice_0").nullifier_hash;
                ok(self.insert("change_0", Record::Change(nf)));
                ok(self.config(None, None, None, None, Some(10_000)));
            }
            Stage::Spent1 => {
                ok(self.spend("change_0"));
            }
            Stage::Change1Inserted => {
                let nf = self.spend_args("change_0").nullifier_hash;
                ok(self.insert("change_1", Record::Change(nf)));
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Initialized,
    Deposited,
    TwoInserted,
    CarolRefundedAndSkipped,
    DaveInserted,
    Approved,
    Spent0,
    Change0Inserted,
    Spent1,
    Change1Inserted,
}

impl Stage {
    pub const ALL: [Stage; 10] = [
        Stage::Initialized,
        Stage::Deposited,
        Stage::TwoInserted,
        Stage::CarolRefundedAndSkipped,
        Stage::DaveInserted,
        Stage::Approved,
        Stage::Spent0,
        Stage::Change0Inserted,
        Stage::Spent1,
        Stage::Change1Inserted,
    ];
}

pub struct PoolView(pub Vec<u8>);

impl PoolView {
    fn at32(&self, o: usize) -> [u8; 32] {
        self.0[8 + o..8 + o + 32].try_into().unwrap()
    }
    fn u64_at(&self, o: usize) -> u64 {
        u64::from_le_bytes(self.0[8 + o..8 + o + 8].try_into().unwrap())
    }
    pub fn deposits_paused(&self) -> bool {
        self.0[8 + 4] == 1
    }
    pub fn roots_len(&self) -> u8 {
        self.0[8 + 5]
    }
    pub fn mint(&self) -> [u8; 32] {
        self.at32(39)
    }
    pub fn vault(&self) -> [u8; 32] {
        self.at32(103)
    }
    pub fn current_root(&self) -> [u8; 32] {
        self.at32(199)
    }
    pub fn next_leaf_index(&self) -> u64 {
        self.u64_at(1255)
    }
    pub fn queue_head(&self) -> u64 {
        self.u64_at(1263)
    }
    pub fn queue_tail(&self) -> u64 {
        self.u64_at(1271)
    }
    pub fn liability(&self) -> u64 {
        self.u64_at(1279)
    }
    pub fn min_deposit(&self) -> u64 {
        self.u64_at(1287)
    }
    pub fn max_deposit(&self) -> u64 {
        self.u64_at(1295)
    }
    pub fn liability_cap(&self) -> u64 {
        self.u64_at(1303)
    }
    pub fn max_relayer_fee(&self) -> u64 {
        self.u64_at(1311)
    }
    pub fn cumulative_deposited(&self) -> u64 {
        self.u64_at(1319)
    }
    pub fn cumulative_outflow(&self) -> u64 {
        self.u64_at(1327)
    }
    pub fn set_u64(&mut self, o: usize, v: u64) {
        self.0[8 + o..8 + o + 8].copy_from_slice(&v.to_le_bytes());
    }
    pub const NEXT_LEAF_INDEX: usize = 1255;
}

/// Record state byte offsets (after the discriminator): PendingDeposit 208, PendingChange 104.
pub fn deposit_state(env: &Env, p: &str, seq: u64) -> u8 {
    env.svm.get_account(&env.deposit_pda(p, seq)).unwrap().data[8 + 208]
}

pub fn change_state(env: &Env, nf: &[u8; 32]) -> u8 {
    env.svm.get_account(&env.change_pda("A", nf)).unwrap().data[8 + 104]
}
