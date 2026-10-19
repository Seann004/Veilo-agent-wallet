# Veilo Protocol Specification v1

| Field | Value |
|---|---|
| Status | Draft-frozen for T06/T07/T08 implementation. Values marked **M2** are measured defaults that must be confirmed before trusted-artifact generation. |
| Protocol version | `1` (`PROTOCOL_VERSION: u8 = 1`), encoding/vector version `v1` |
| Scope | Note model, encodings, hashes, trees, circuits (spend, insert, exit), Anchor program `privacy-pool` accounts and instructions, Groth16 verification, events, errors, deployment manifest, cross-language vectors |
| Normative source | Product requirements, sections 6.2a, 7, 8.1, 13, 15, 22 and 23. **Veilo decision (v1)** identifies an implementation choice. |

Conventions: MUST/SHOULD as in the specification. `||` is byte concatenation. `u8`, `u64_be` are fixed-width unsigned big-endian. `be32(x)` is the 32-byte big-endian encoding of a field element `x`. `int_be(b)` reads bytes as an unsigned big-endian integer. Hex is lowercase. Decimal is used for field elements in vectors. ASCII tags carry no terminator or length prefix.

Rule of precedence: if code and this file disagree, fix one of them in the same change and regenerate vectors. Any change to sections 2–7 is a protocol change: it requires new vectors, new circuit artifacts and a new deployment manifest (specification 7.1, 24.1).

---

## 1. Curve, proof system and hash

### 1.1 Curve and proof system

- Curve: BN254 (alt_bn128). Proof system: Groth16. Circuits: circom 2 (`--prime bn128`, the default). Proving and off-chain verification: snarkjs. On-chain verification: `groth16-solana` over Solana `alt_bn128` syscalls (section 9).
- Scalar field modulus:

```text
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
  = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
be32(r) = 30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
```

- `2^248 < r`, so any 31-byte big-endian integer is a valid field element.
- Every public input, every Poseidon input and every on-chain field argument MUST satisfy `0 <= x < r`. Nothing is ever reduced modulo `r` on the program side.

### 1.2 Poseidon

`H_n` is circomlib Poseidon over BN254 with `n` inputs, width `t = n + 1`, S-box `x^5`, 8 full rounds and `N_ROUNDS_P[t-2]` partial rounds, where `N_ROUNDS_P = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68]`, with circomlib's round constants and MDS matrices. The capacity element is initialised to 0. The output is state element 0.

| Name | Arity | Width t | Partial rounds | Used for |
|---|---|---|---|---|
| `H2(a, b)` | 2 | 3 | 57 | Precommitment, nullifier hash, Merkle nodes, zero values |
| `H3(a, b, c)` | 3 | 4 | 56 | Note commitment |

No other arity is used in v1. `H1` is not used.

Implementations (all MUST reproduce section 11 vectors):

| Environment | Implementation | Call |
|---|---|---|
| circom | `circomlib/circuits/poseidon.circom` | `Poseidon(2)`, `Poseidon(3)` |
| TypeScript | `circomlibjs` `buildPoseidon()` (or `poseidon-lite` if it matches the vectors) | `poseidon([a, b])`, `F.toObject(...)` |
| Solana program | `solana-poseidon` `hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&be32(a), ...])`, which invokes the `sol_poseidon` syscall on-chain | |
| Rust off-chain/tests | `light-poseidon` `Poseidon::<Fr>::new_circom(n)` with `hash_bytes_be` (the off-chain branch of `solana-poseidon` uses it) | |

Verified compatibility facts (see References):

- circomlib `poseidon.circom` and circomlibjs `poseidon_reference.js` both use `nRoundsF = 8` and the `N_ROUNDS_P` table above over bn128.
- light-poseidon `new_circom` uses BN254, x^5, 8 full rounds and the same partial-round table for t = 2..13. Its test suite compares against circomlibjs outputs. Its `new_circom(2)` test for inputs (1, 2) yields `0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a` = `7853200120776062878684798364095072458815029376092732009249414926327459813530`, which is the circomlibjs `poseidon([1, 2])` value. This is vector `poseidon[0]` in section 11.
- light-poseidon and `sol_poseidon` reject inputs that are not exactly 32 bytes (`InvalidInputLength`) and inputs `>= r` (`InputLargerThanModulus`). They accept at most 12 inputs.
- `sol_poseidon` costs `61 * n^2 + 542` CU, so H3 costs 1,091 CU and H2 costs 786 CU.
- The Poseidon syscall feature gate `FL9RsQA6TVUoh5xJQ9d936RHSebA1NLQqe3Zv9sXZRpr` is active on devnet. Its feature account records activation slot 310,608,000 (queried 2026-10-14).
- circomlibjs does not range-check inputs. The TS SDK MUST reject `x >= r` before hashing.

**Veilo decision (v1):** The program calls Poseidon exactly once: `H3` at `deposit` to compute the deposit leaf (section 8.4.2). All other Poseidon work happens in circuits and the SDK.

### 1.3 SHA-256

`SHA256` is FIPS 180-4 SHA-256. On-chain it is computed with `solana_program::hash::hashv` (the `sol_sha256` syscall: 85 CU base + 1 CU per byte). It is used only for the label (section 4) and the intent context (section 5). In both cases the output is truncated to the first 31 bytes and read with `int_be`, which gives a 248-bit value below `r`.

---

## 2. Canonical encodings

### 2.1 Field elements

- Canonical form: exactly 32 bytes, big-endian, value `< r`. There is no shorter or longer form, no little-endian form and no reduction. In Anchor instruction arguments a field element is the type `[u8; 32]` (Borsh writes it raw), never a Borsh integer.
- Check (Rust): `is_less_than_bn254_field_size_be(&x)` (lexicographic byte comparison with `be32(r)`). Program error: `NonCanonicalFieldElement`.
- TS: `bigint` in `[0, r)`. `toBe32(x)` left-pads to 32 bytes and throws if `x < 0 || x >= r`. `fromBe32(b)` throws unless `b.length === 32 && int_be(b) < r`.
- circom: signals are field elements by construction. snarkjs `publicSignals` are decimal strings and convert with `toBe32`.
- Zero is canonical (`00…00`). Rules about when zero is forbidden are stated per field.

### 2.2 Aliases and replay keys

- Nullifier and precommitment uniqueness are enforced by PDAs seeded with the canonical 32 bytes (section 8.1). Because the length is fixed at 32 and the value must be `< r`, each field element has exactly one seed. Neither `x + r` nor a leading-zero-stripped or extended form can produce a second account.
- The program MUST run the canonical check before deriving any PDA from a field argument and before calling the verifier. The verifier is also called through `verify()` (checked), never `verify_unchecked()`.
- Groth16 proofs are malleable (re-randomisable). Proof bytes MUST NOT be used as a uniqueness key. Only the nullifier hash is.

### 2.3 Integers

| Quantity | Rust/on-chain type | In a hash preimage | As a field element / public input |
|---|---|---|---|
| Token amount (value, payout, fee, deposit) | `u64` | `u64_be` (8 bytes) | the integer itself, `be32(v)` (24 zero bytes + `u64_be`) |
| Slot (`valid_until_slot`) | `u64` | `u64_be` | not a circuit input |
| Leaf index | `u64` on-chain, must be `< 2^16` | n/a | the integer itself |
| Queue sequence | `u64` | n/a | n/a (PDA seed uses `u64` little-endian, section 8.1) |

Borsh (Anchor instruction data and account data) encodes `u64` little-endian. Hash preimages and public inputs use big-endian. Implementations MUST NOT mix the two.

### 2.4 Public keys

Solana public keys are 32 bytes and can be `>= r`, so **no raw public key ever enters a circuit or Poseidon**. Each key is bound by SHA-256 truncation inside the label (section 4) or the intent context (section 5). A key in a hash preimage is its raw 32 bytes, the base58-decoded address.

The devnet genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` decodes to 32 bytes `ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab`. CAIP-2: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.

---

## 3. Note model

### 3.1 Definitions

A note is `(value, label, nullifier_secret, note_secret)`. The SDK backup also keeps `salt`, `refund_authority`, `leaf_index` and `queue_seq`.

```text
precommitment  = H2(nullifier_secret, note_secret)
commitment     = H3(value, label, precommitment)          # specification 7.2, verbatim
nullifier_hash = H2(nullifier_secret, label)              # Veilo decision (v1)
```

- `value`: integer in `[0, 2^64)`, in token base units. A note with value 0 can exist (a change note after a full spend). It cannot be exited (section 8.4.8).
- `label`: section 4. It is nonzero. A change note inherits its parent's label unchanged.
- `nullifier_secret`, `note_secret`: uniformly random field elements in `[1, r)` that only the owner knows.

### 3.2 Pool-scoped nullifier

**Veilo decision (v1):** `nullifier_hash = H2(nullifier_secret, label)`.

- Pool scoping is cryptographic. The label commits to the pool PoolState address and mint (section 4). Every leaf in a pool's tree carries a label derived for that pool: deposit leaves get a program-derived label, and change leaves inherit it in-circuit. So a nullifier hash is bound to its pool without an extra public input or a raw-pubkey-to-field mapping.
- The namespace is also scoped on-chain. `SpentNullifier` PDAs are seeded by `(PoolState, nullifier_hash)`.
- Spend and exit share the namespace: both circuits compute the identical `H2(nullifier_secret, label)` from the same note, and both instructions `init` the same `SpentNullifier` PDA. So a note is consumed exactly once by either path (PRIV-03, specification 7.2a).
- Unlinkability: the observer knows `label` and `precommitment` from the deposit, but `nullifier_hash` additionally depends on the secret `nullifier_secret`.
- SDK rule: `note_secret != label` (otherwise `precommitment == nullifier_hash` and the public deposit would link to its spend). With random secrets this has negligible probability. The SDK still checks it and re-derives at the next index.

### 3.3 Change notes and fresh secrets

A spend of note `N` with withdrawal `w` creates change `N'`:

```text
remainder        = N.value - w            # in [0, 2^64), range-checked in circuit
N'.label         = N.label
N'.nullifier_sec = fresh, != N.nullifier_secret (circuit-enforced)
N'.note_secret   = fresh
new_commitment   = H3(remainder, N.label, H2(N'.nullifier_sec, N'.note_secret))
```

A change note is always created, including when `remainder = 0`, so a full spend is not distinguishable on-chain. The circuit can enforce only inequality with the parent's nullifier secret. Freshness is an SDK obligation (section 3.4). The change becomes spendable only after its `insert_leaf` is finalized and the SDK has rebuilt its Merkle witness (specification 6.2a).

### 3.4 SDK key derivation

**Veilo decision (v1):** Use HKDF-SHA256 (RFC 5869) with an empty salt. IKM is the 32-byte wallet-service note seed, and the info strings are exact ASCII followed by a decimal index:

| Output | Info | Length | Post-processing |
|---|---|---|---|
| `nullifier_secret_i` | `veilo/nullifier/v1/<i>` | 64 | `int_be(okm) mod r`; reject 0 |
| `note_secret_i` | `veilo/secret/v1/<i>` | 64 | `int_be(okm) mod r`; reject 0 |
| deposit `salt_i` | `veilo/salt/v1/<i>` | 32 | raw 32 bytes |
| one-time payment key `j` | `veilo/onetime/v1/<j>` | 32 | Ed25519 seed |

Indices are allocated monotonically and persisted durably before first use (specification 7.3, 9). Deposits and change notes draw from the same `i` counter. A restore MUST NOT reuse an allocated index. The seed alone is not promised to recover every change note; the encrypted backup is authoritative (specification 9).

---

## 4. Label (specification 7.2a, verbatim construction)

```text
label_preimage = "veilo/label/v1"      14 bytes ASCII  (76 65 69 6c 6f 2f 6c 61 62 65 6c 2f 76 31)
              || pool                  32 bytes  PoolState account address
              || mint                  32 bytes  pinned mint address
              || refund_authority      32 bytes  depositor / refund signer public key
              || salt                  32 bytes  unique per deposit
                                       = 142 bytes
label = int_be( SHA256(label_preimage)[0..31] )
```

- "pool public key" means the PoolState PDA address, not `pool_id`.
- `label = 0` is rejected (`ZeroLabel`). This is unreachable in practice, but the check is mandatory because 0 is the empty leaf of the approved tree.
- `deposit` derives the label from the actual signer (`refund_authority`), the PoolState key, the pinned mint and the `salt` argument, then stores `salt` and `refund_authority` in `PendingDeposit`.
- `exit_public` re-derives the label from the exit signer, the PoolState key, the pinned mint and the disclosed `salt`, and passes it to the exit verifier as a public input. An attacker signer yields a different label, so verification fails (EXIT-01).
- `salt` uniqueness is an SDK obligation (HKDF index, section 3.4). The program does not enforce it. A duplicated salt gives two notes the same label, which harms only that owner's privacy. Precommitment uniqueness is enforced.

Draft known answer (to be reproduced by `label[0]` in section 11): pool = `11`×32, mint = `22`×32, refund = `33`×32, salt = `44`×32:

```text
SHA256 = 0f45865e3b3b52830c96b11a2c977348dbfd84cf4d68f4883bc3ee6ec3e8d414
label  = 26982549026179648375948272714466525149453452057491867059920738696902731988
be32   = 000f45865e3b3b52830c96b11a2c977348dbfd84cf4d68f4883bc3ee6ec3e8d4
```

---

## 5. Withdrawal intent and context

### 5.1 Intent type (Anchor instruction argument)

```rust
pub struct WithdrawalIntent {
    pub destination_token_account: Pubkey, // fresh payment wallet's exact-mint token account
    pub destination_owner: Pubkey,         // its owner (the fresh signer)
    pub payout_amount: u64,                // > 0
    pub relayer_fee: u64,                  // <= PoolState.max_relayer_fee (default 0)
    pub relayer: Option<Pubkey>,           // the only key allowed to submit, if Some
    pub relayer_fee_token_account: Option<Pubkey>,
    pub valid_until_slot: u64,
}
```

Context-only fields (program id, pool, genesis, mint) are taken from the program and PoolState, never from the instruction. No task, agent, workspace, quote or gateway account identifier exists in the intent (specification 3.3, 7.2).

### 5.2 Serialization and hash

```text
intent_bytes = "veilo/intent/v1"               15  ASCII (76 65 69 6c 6f 2f 69 6e 74 65 6e 74 2f 76 31)
            || program_id                      32  crate::ID
            || pool                            32  PoolState address
            || genesis_hash                    32  PoolState.genesis_hash (raw)
            || mint                            32  PoolState.mint
            || destination_token_account       32
            || destination_owner               32
            || u64_be(payout_amount)            8
            || u64_be(relayer_fee)              8
            || u8(relayer_present)              1  0x00 or 0x01
            || relayer_or_zero                 32  32 zero bytes when absent
            || relayer_fee_token_account_or_zero 32 32 zero bytes when absent
            || u64_be(valid_until_slot)         8
                                             = 296 bytes
context = int_be( SHA256(intent_bytes)[0..31] )
withdrawn_value = payout_amount + relayer_fee   (checked u64; public input)
```

**Veilo decision (v1):** SHA-256 is used (cheap `sol_sha256` syscall, same primitive as the label), with fixed-width fields and no variable-length encoding.

Intent validity rules (program, `spend_private`; SDK MUST pre-check identically):

1. `payout_amount > 0`, and `withdrawn_value` does not overflow.
2. `relayer = None` implies `relayer_fee == 0` and `relayer_fee_token_account = None`.
3. `relayer = Some(k)` requires the transaction signer `relayer` account to equal `k`. If `relayer_fee > 0`, then `relayer_fee_token_account = Some(a)` and `a` is a token account of the pinned mint with owner `k`. If `relayer_fee == 0`, then `relayer_fee_token_account = None`.
4. `relayer_fee <= PoolState.max_relayer_fee`. The default is 0, so the zero-fee default rejects any fee.
5. Slot bound (specification 7.2a/7.2b): let `s = Clock::get()?.slot`. Reject if `s > valid_until_slot` (`IntentExpired`). Reject if `valid_until_slot - s > MAX_INTENT_SLOTS` (750) (`IntentTooFarInFuture`). The SDK sets `valid_until_slot <= finalized_slot_observed + 750`. Since the on-chain slot is at least the finalized slot, the on-chain check is never stricter for an honest issuer.
6. A proof whose intent fields are changed (including `valid_until_slot`) yields a different `context` and fails verification (EXP-01). Putting an old proof in a fresh-blockhash transaction does not extend the bound.

Draft known answers (to be reproduced by `intent[0..1]`). Both use program = `aa`×32, pool = `11`×32, devnet genesis bytes, devnet USDC mint `3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7`, destination token account = `55`×32, destination owner = `66`×32, valid_until_slot = 400000750:

| Vector | payout | fee | relayer | fee account | SHA256 | context |
|---|---|---|---|---|---|---|
| intent[0] | 1000000 | 0 | absent | absent | `d91ccb1c242e85ad3fa00d279d0c615549167c2cacdb653fdc826e1289e0f7a5` | `383604537787421432873602590773414849761730441832740634255932250059287683319` |
| intent[1] | 990000 | 10000 | `77`×32 | `88`×32 | `f12709af5caf287beff377c7ea36d5fb754dd21656f13bf4ca3ab11524ef5578` | `426079571826414574869686923751093208027994267944572661321022180604323884885` |

---

## 6. Trees

| Constant | Value | Status |
|---|---|---|
| `TREE_DEPTH` (commitment tree) | 16, capacity `TREE_CAPACITY = 65,536` leaves | specification default; **M2** confirm |
| `APPROVED_TREE_DEPTH` (approved label tree) | 16 | **Veilo decision (v1)**, matches specification "approved-set depth matches configured label-tree depth"; **M2** |
| `ROOT_HISTORY` | 32 commitment roots (newest 32, including current) | specification default |
| Approved root history | none: only the current approved root is accepted | specification 7.2b |

- Node: `parent = H2(left, right)`. Empty leaf: `0`.
- Zero values: `Z[0] = 0`, `Z[i+1] = H2(Z[i], Z[i])`. Empty commitment root = empty approved root = `Z[16]`. The program embeds `EMPTY_ROOT = be32(Z[16])` as a constant that is tested against `zeros[16]` in the vectors. It is not recomputed on-chain.
- Index/path convention: bit `i` of `leaf_index` (LSB = level 0) is 1 when the running node is the right child at level `i`. At level `i`: `(l, r) = bit ? (sibling_i, cur) : (cur, sibling_i)`.
- Commitment tree leaves are appended in strict order `0, 1, 2, …` by `insert_leaf` only. `PoolState.next_leaf_index` is the next free index. Leaves are never overwritten.
- Approved tree leaves are labels (nonzero), maintained off-chain by the approval authority. Only its root is on-chain (`ApprovalState`).
- Root history: a ring buffer `root_history[32]` with `roots_next` (next write slot) and `roots_len` (1..=32). `initialize_pool` writes `EMPTY_ROOT` at slot 0 (`roots_len = 1`, `roots_next = 1`). Each insert writes the new root at `roots_next`, sets `roots_next = (roots_next + 1) % 32` and `roots_len = min(roots_len + 1, 32)`, and sets `current_root`. "Known root" means equal to one of the first `roots_len` live entries. Spend and exit accept any known root. Insert accepts only `current_root`.

Capacity (**Veilo decision (v1)**). Let `live = queue_tail - queue_head` and `reserved = next_leaf_index + live`, with `CHANGE_RESERVE = 1024`:

- `deposit` requires `reserved + 1 <= TREE_CAPACITY - CHANGE_RESERVE`, else `TreeCapacityExhausted`.
- `spend_private` requires `reserved + 1 <= TREE_CAPACITY`, else `TreeCapacityExhausted`.
- `exit_public` and `refund_pending_deposit` need no capacity, so funds always remain exitable or refundable. Over-capacity paths reject before any transfer. Tree slots are never overwritten (specification 7.2b).

---

## 7. Circuits

General rules:

- `pragma circom 2.x` (exact compiler version pinned by T01 and recorded in the manifest). Compile with `circom <c>.circom --r1cs --wasm --sym --O2 --prime bn128`. **Veilo decision (v1):** `--O2`; **M2** measured.
- **Veilo decision (v1):** main templates have **no output signals**. Every public signal is an `input`, declared in the template in exactly the order listed below and listed in `component main {public [...]}` in the same order. The Groth16 public input vector equals that order. T06 MUST include a test that reads the compiled `.sym`/`public.json` for a known witness and asserts the order. This removes any dependence on circom's output-before-input convention.
- Library templates: circomlib `Poseidon`, `Num2Bits`, `IsZero`. A shared `lib/merkle.circom` provides `MerkleRoot(depth)`: `Num2Bits(depth)` on the index (which also proves `index < 2^depth`), then the section 6 path rule.
- Every numbered constraint below needs at least one negative test (witness failure or proof rejection) in T06.

### 7.1 `spend` (depth 16)

Public inputs, in order (6). The order follows specification 7.2's listing:

| # | Signal | Source on-chain |
|---|---|---|
| 0 | `context` | recomputed by program (section 5) |
| 1 | `stateRoot` | instruction arg; must be a known root |
| 2 | `approvedRoot` | `ApprovalState.approved_root` (current only) |
| 3 | `nullifierHash` | instruction arg; seeds `SpentNullifier` |
| 4 | `withdrawnValue` | `payout_amount + relayer_fee` |
| 5 | `newCommitment` | instruction arg; nonzero; stored in `PendingChange` |

Private inputs: `value`, `label`, `nullifierSecret`, `noteSecret`, `stateIndex`, `stateSiblings[16]`, `approvedIndex`, `approvedSiblings[16]`, `newNullifierSecret`, `newNoteSecret`.

Constraints:

1. `Num2Bits(64)(value)`, `Num2Bits(64)(withdrawnValue)`.
2. `remainder <== value - withdrawnValue`; `Num2Bits(64)(remainder)`. With constraint 1 this proves `withdrawnValue <= value` with no field wrap (PRIV-04).
3. `commitment = H3(value, label, H2(nullifierSecret, noteSecret))`.
4. `MerkleRoot(16)(commitment, stateIndex, stateSiblings) === stateRoot`.
5. `IsZero(label).out === 0` (nonzero label).
6. `MerkleRoot(16)(label, approvedIndex, approvedSiblings) === approvedRoot`.
7. `nullifierHash === H2(nullifierSecret, label)`.
8. `IsZero(newNullifierSecret - nullifierSecret).out === 0`.
9. `newCommitment === H3(remainder, label, H2(newNullifierSecret, newNoteSecret))` (same label).
10. `contextSquare <== context * context` (a defensive non-linear use of `context`. Groth16 already binds every public input through the IC terms).

### 7.2 `insert` (depth 16, one leaf)

Public inputs, in order (4): `oldRoot`, `newRoot`, `leafIndex`, `leaf`. Private: `siblings[16]`.

1. `IsZero(leaf).out === 0`.
2. `MerkleRoot(16)(0, leafIndex, siblings) === oldRoot` (the slot is empty under the current root; this also range-checks `leafIndex < 2^16`).
3. `MerkleRoot(16)(leaf, leafIndex, siblings) === newRoot` (same siblings).

The program supplies every public input from chain state: `oldRoot = PoolState.current_root`, `leafIndex = PoolState.next_leaf_index`, `leaf = head_record.commitment`. Only `newRoot` comes from the submitter, and the proof binds it. The insert proof needs no secret, so anyone can produce one.

How the leaf derives from records (**Veilo decision (v1)**):

- Deposit: `PendingDeposit.commitment = H3(amount_received, label, precommitment)`, computed by the program at `deposit` with `sol_poseidon` from the program-derived label, the actually received amount and the canonical precommitment.
- Change: `PendingChange.commitment = newCommitment` from the verified spend proof.

### 7.3 `exit` (depth 16)

Public inputs, in order (4): `stateRoot`, `label`, `value`, `nullifierHash`. Private: `nullifierSecret`, `noteSecret`, `index`, `siblings[16]`.

1. `Num2Bits(64)(value)`.
2. `IsZero(label).out === 0`.
3. `commitment = H3(value, label, H2(nullifierSecret, noteSecret))`; `MerkleRoot(16)(commitment, index, siblings) === stateRoot`.
4. `nullifierHash === H2(nullifierSecret, label)`.

There is no approved-root input and no context. The payout destination is fixed by the program to the refund signer's ATA, and the label is program-derived from that signer, so a copied exit proof cannot be redirected.

### 7.4 Sizes (measured M2, T06)

Sources: `circuits/src/{spend,insert,exit}.circom`, shared `circuits/src/lib/{merkle,note}.circom`, circom 2.2.3 `--O2`, circomlib 2.0.5. Hashes and counts are in `artifacts/circuits/manifest.json`; timings in `artifacts/circuits/measurements.json`.

| Circuit | Main costs | Estimate | Measured constraints (non-linear; 0 linear) | Public / private inputs | ptau power |
|---|---|---|---|---|---|
| spend | 32 × H2 path + 2 × H3 + 3 × H2 + 3 × Num2Bits(64) | ~11k | 9,181 | 6 / 40 | 2^15 |
| insert | 32 × H2 | ~8k | 7,745 | 4 / 16 | 2^15 |
| exit | 16 × H2 + H3 + H2 + Num2Bits(64) | ~5k | 4,678 | 4 / 19 | 2^15 |

All three fit 2^14; power 15 is kept for headroom. Proving with snarkjs 0.7.6 `groth16.fullProve` (WASM witness, JS prover) on the development host (Intel i5-1235U, 12 logical CPUs, 16 GiB, Windows 11, Node 22.14), median of 3: spend 697 ms, insert 512 ms, exit 387 ms; witness generation alone 47–57 ms; snarkjs verification 11–18 ms. Proof bytes: 256 (a 64 + b 128 + c 64). Public-input bytes: spend 192, insert and exit 128. Proving files: spend zkey 5.6 MB, insert 4.4 MB, exit 2.9 MB; each WASM about 2 MB. Depth 16 for both trees is confirmed as feasible.

**Veilo decision (v1, revised in T06):** All three use one power-15 Phase 1 file generated locally with snarkjs (`powersoftau new bn128 15`, a public beacon `sha256("veilo/dev-setup/v1/phase1")` with 2^10 iterations, `prepare phase2`) instead of the Hermez file. Phase 2 per circuit is `zkey new` plus a public beacon `sha256("veilo/dev-setup/v1/phase2/<circuit>")` and is checked with `zkey verify`. This default is deterministic: anyone can rebuild byte-identical files and compare them with the manifest hashes, and anyone can also derive the toxic waste and forge proofs. It is labeled "development setup, not a trusted ceremony" in the manifest and is acceptable only for devnet test funds. `circuits/scripts/build.ts --secret-contribution` adds an OS-entropy contribution before each beacon. That output is not reproducible, so its .ptau/.zkey files must be archived with the manifest. Scripts: `circuits/scripts/build.ts` (compile, setup, manifest, VK export) and `circuits/scripts/groth16-vectors.ts` (sample proofs, measurements).

---

## 8. Program `privacy-pool`

Anchor/Rust. Every instruction verifies canonical PDA bumps (`seeds` + `bump` constraints), account owner = program for program accounts, `token_program == spl_token::ID` (original SPL Token, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`), `mint == PoolState.mint`, and that every pool-scoped account's `pool` field equals the PoolState key (specification 7.2c). Token-2022 is rejected. There is no `sweep`, `admin_withdraw`, `close_pool` or key-replacement instruction. All arithmetic is `checked_*`. A failing instruction reverts all state, including CPI transfers (Solana transaction atomicity).

### 8.1 Seeds (exact byte strings)

| Account | Seeds | Notes |
|---|---|---|
| PoolState | `[b"pool", pool_id]` | `pool_id: [u8; 32]` chosen once by the deployer, recorded in the manifest (`POOL_ID`) |
| VaultAuthority | `[b"vault_authority", pool_state.key()]` | PDA with no data. Signs vault transfers via `invoke_signed` |
| TokenVault | ATA of (VaultAuthority, mint) under SPL Token | created in `initialize_pool`. No delegate, no close authority |
| PendingDeposit | `[b"deposit", pool_state.key(), queue_seq.to_le_bytes()]` | `queue_seq: u64` is the "deposit sequence" (specification 7.2c). It is drawn from the shared queue counter, so deposit sequences have gaps where change records were enqueued |
| SeenPrecommitment | `[b"precommitment", pool_state.key(), precommitment_be32]` | permanent |
| PendingChange | `[b"change", pool_state.key(), nullifier_hash_be32]` | one per consumed note |
| SpentNullifier | `[b"nullifier", pool_state.key(), nullifier_hash_be32]` | permanent, shared by spend and exit, never closed |
| ApprovalState | `[b"approval", pool_state.key()]` | |

No task, agent, workspace or account identifier appears in any seed. **Veilo decision (v1):** no v1 program account is ever closed. Rent is measured in M2 (open item).

### 8.2 Constants (compiled into the program)

| Name | Value |
|---|---|
| `PROTOCOL_VERSION` | 1 |
| `TREE_DEPTH`, `APPROVED_TREE_DEPTH` | 16, 16 |
| `TREE_CAPACITY` | 65,536 |
| `CHANGE_RESERVE` | 1,024 |
| `ROOT_HISTORY` | 32 |
| `QUEUE_MAX_LIVE_DEPOSITS` | 64 (**M2**). Deposit rejects when `live >= 64` |
| `MAX_INTENT_SLOTS` | 750 |
| `HARD_MAX_DEPOSIT` | 20,000,000 |
| `HARD_LIABILITY_CAP` | 100,000,000 |
| `HARD_MAX_RELAYER_FEE` | 100,000 (**Veilo decision (v1)**) |
| `EMPTY_ROOT` | `be32(Z[16])` from vectors |
| `EXPECTED_GENESIS` | build feature `devnet`: `ce59db50…03ab`. Feature `localnet` (tests only): the value supplied at init, but the mainnet-beta genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` is always rejected |
| `SPEND_VK`, `INSERT_VK`, `EXIT_VK` | generated `Groth16Verifyingkey` constants (section 9.3) |

Config defaults (bounded, changeable only by `update_config`): `min_deposit = 100,000`, `max_deposit = 20,000,000`, `liability_cap = 100,000,000`, `max_relayer_fee = 0`, `deposits_paused = false`.

### 8.3 Account layouts (Borsh, listed order; sizes include the 8-byte Anchor discriminator)

**PoolState**: 1,407 bytes

| Field | Type | Bytes |
|---|---|---|
| protocol_version | u8 | 1 |
| bump | u8 | 1 |
| vault_authority_bump | u8 | 1 |
| mint_decimals | u8 | 1 |
| deposits_paused | bool | 1 |
| roots_len | u8 | 1 |
| roots_next | u8 | 1 |
| pool_id | [u8;32] | 32 |
| mint | Pubkey | 32 |
| token_program | Pubkey | 32 |
| vault | Pubkey | 32 |
| genesis_hash | [u8;32] | 32 |
| config_authority | Pubkey | 32 |
| current_root | [u8;32] | 32 |
| root_history | [[u8;32];32] | 1,024 |
| next_leaf_index | u64 | 8 |
| queue_head | u64 | 8 |
| queue_tail | u64 | 8 |
| liability | u64 | 8 |
| min_deposit | u64 | 8 |
| max_deposit | u64 | 8 |
| liability_cap | u64 | 8 |
| max_relayer_fee | u64 | 8 |
| cumulative_deposited | u64 | 8 |
| cumulative_outflow | u64 | 8 |
| reserved | [u8;64] | 64 |

Invariant: `liability == cumulative_deposited - cumulative_outflow` and `vault.amount >= liability`.

**PendingDeposit**: 234 bytes: `pool: Pubkey, queue_seq: u64, refund_authority: Pubkey, salt: [u8;32], label: [u8;32], precommitment: [u8;32], commitment: [u8;32], amount: u64, state: u8, leaf_index: u64, created_slot: u64, bump: u8`. `state`: 0 Pending, 1 Inserted, 2 Refunded, 3 Skipped (a refunded record after the queue passed it). `leaf_index = u64::MAX` until inserted.

**PendingChange**: 130 bytes: `pool: Pubkey, queue_seq: u64, nullifier_hash: [u8;32], commitment: [u8;32], state: u8 (0 Pending, 1 Inserted), leaf_index: u64, created_slot: u64, bump: u8`. It holds no value, owner or agent data.

**SeenPrecommitment**: 49 bytes: `pool: Pubkey, queue_seq: u64, bump: u8`.

**SpentNullifier**: 50 bytes: `pool: Pubkey, kind: u8 (1 spend, 2 exit), slot: u64, bump: u8`.

**ApprovalState**: 121 bytes: `pool: Pubkey, approval_authority: Pubkey, approved_root: [u8;32], version: u64, updated_slot: u64, bump: u8`.

### 8.4 Instructions

Common argument types: `Groth16Proof { a: [u8;64], b: [u8;128], c: [u8;64] }` (256 bytes, encoding in section 9.2). Field elements are `[u8;32]` canonical. `(m)` = mutable, `(s)` = signer, `(init)` = created with `payer`.

#### 8.4.1 `initialize_pool(pool_id, genesis_hash, expected_decimals, approval_authority, config_authority)`

Accounts: `deployer (s, m)`; `program_data` (the program's ProgramData, `upgrade_authority_address == Some(deployer)`); `pool_state (init, seeds)`; `vault_authority (seeds)`; `mint`; `vault (init, ATA of vault_authority)`; `approval_state (init, seeds)`; `token_program`, `associated_token_program`, `system_program`.

Checks: deployer is the upgrade authority (prevents front-run initialization with foreign authorities). `genesis_hash == EXPECTED_GENESIS` (devnet build). `mint.owner == spl_token::ID`, mint initialized, `mint.decimals == expected_decimals`. `token_program == spl_token::ID`. Anchor `init` rejects repeated initialization.

Effects: store all PoolState fields. `current_root = root_history[0] = EMPTY_ROOT`, counters 0, config defaults (section 8.2). `approved_root = EMPTY_ROOT`, `version = 0`. Emit `PoolInitialized`.

The devnet USDC mint has a freeze authority (`CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT`, queried 2026-10-14). The program cannot prevent the issuer freezing the vault. This is a disclosed risk recorded in the manifest.

#### 8.4.2 `deposit(amount: u64, precommitment: [u8;32], salt: [u8;32])`

Accounts: `depositor (s)` (refund authority and source token authority); `payer (s, m)` (may equal depositor); `pool_state (m)`; `source (m)` (token account, `mint == pool.mint`, `owner == depositor`); `vault (m)`; `pending_deposit (init, seeds [b"deposit", pool, pool.queue_tail LE])`; `seen_precommitment (init, seeds)`; `token_program`, `system_program`.

Checks, in order:

1. `!deposits_paused`.
2. `min_deposit <= amount <= max_deposit`.
3. `liability + amount <= liability_cap` (pending deposits count, per specification 7.2c).
4. Capacity (section 6) and `live < QUEUE_MAX_LIVE_DEPOSITS`.
5. `precommitment` canonical and nonzero.
6. Derive `label` (section 4) and require it nonzero.
7. `vault_before = vault.amount`; `transfer_checked(source → vault, amount, decimals)`, then reload: `vault.amount - vault_before == amount`, else `TransferAmountMismatch`.
8. `commitment = H3(amount, label, precommitment)` via `sol_poseidon`.

Effects: write `PendingDeposit {state: Pending, queue_seq: queue_tail, …}` and `SeenPrecommitment {queue_seq}`. `queue_tail += 1`; `liability += amount`; `cumulative_deposited += amount`. Emit `DepositQueued`. A duplicate precommitment fails at `init` (`PRIV-05`).

#### 8.4.3 `refund_pending_deposit()`

Accounts: `refund_authority (s)`; `pool_state (m)`; `pending_deposit (m)`; `vault (m)`; `vault_authority`; `destination (m)`, which MUST equal `get_associated_token_address(refund_authority, mint)` and be an initialized token account of the mint; `token_program`.

Checks: `pending_deposit.pool == pool_state`; `refund_authority == pending_deposit.refund_authority`; `state == Pending`, else `DepositNotPending` (an inserted deposit leaves only by spend or exit).

Effects: transfer `amount` from vault to destination, signed by VaultAuthority. `state = Refunded`; `liability -= amount`; `cumulative_outflow += amount`. Emit `DepositRefunded`. `queue_head` is not moved. The tombstone is skipped when it reaches the head (section 8.4.5). The account's single-writer state change serializes refund against insert, so at most one succeeds.

#### 8.4.4 `insert_leaf(proof, new_root: [u8;32])`

Accounts: `submitter (s)` (any funded key); `pool_state (m)`; `pending_deposit: Option<Account<PendingDeposit>> (m)`; `pending_change: Option<Account<PendingChange>> (m)`. Exactly one is `Some`, else `InvalidQueueItem`.

Checks: `record.pool == pool_state`; `record.queue_seq == pool.queue_head`, else `NotQueueHead`; `record.state == Pending`, else `QueueItemNotPending`; `next_leaf_index < TREE_CAPACITY`; `new_root` canonical; `INSERT_VK` verifies `[current_root, new_root, be32(next_leaf_index), record.commitment]`.

Effects: `record.state = Inserted`, `record.leaf_index = next_leaf_index`; push `new_root` to the history; `next_leaf_index += 1`; `queue_head += 1`. Emit `LeafInserted`.

#### 8.4.5 `skip_refunded_deposit()` (Veilo addition, specification 7.2b "queue transitions include canceled records deterministically")

Accounts: `submitter (s)`; `pool_state (m)`; `pending_deposit (m)`.

Checks: `pool` match; `queue_seq == queue_head`; `state == Refunded`.

Effects: `state = Skipped`; `queue_head += 1`. Roots, `next_leaf_index` and liability are unchanged. Emit `QueueItemSkipped`. A refunded record therefore never consumes a leaf index, and an insert proof built for a later item (whose `leafIndex` equals the then-current `next_leaf_index`) is unaffected by the skip. An insert proof built for a record that is refunded first fails `QueueItemNotPending` and changes nothing.

#### 8.4.6 `update_approved_root(new_root: [u8;32])`

Accounts: `approval_authority (s)`; `pool_state`; `approval_state (m)`.

Checks: signer equals `approval_state.approval_authority`; `new_root` canonical.

Effects: `approved_root = new_root`, `version += 1`, `updated_slot = slot`. Emit `ApprovedRootUpdated`. This instruction touches nothing else.

Prototype approval rule (published): the operator approves labels of finalized, inserted deposits made by the configured synthetic/test participants. There is no sanctions or compliance screening, and none is claimed (specification 7.2).

#### 8.4.7 `spend_private(proof, state_root: [u8;32], nullifier_hash: [u8;32], new_commitment: [u8;32], intent: WithdrawalIntent)`

Accounts: `payer (s, m)` (fee/rent sponsor); `relayer: Option<Signer>` (required when `intent.relayer` is Some, and must equal it); `pool_state (m)`; `approval_state`; `vault (m)`; `vault_authority`; `destination (m)`; `relayer_fee_account: Option (m)`; `spent_nullifier (init, seeds)`; `pending_change (init, seeds [b"change", pool, nullifier_hash])`; `token_program`, `system_program`.

Checks:

1. `state_root`, `nullifier_hash` and `new_commitment` are canonical; `new_commitment != 0`.
2. `state_root` is a known root (`UnknownStateRoot`).
3. `approval_state.pool == pool_state`.
4. Intent rules 1–5 (section 5.2).
5. `destination.key == intent.destination_token_account`, `destination.mint == mint`, `destination.owner == intent.destination_owner`, the account is initialized and not frozen, and `destination != vault`.
6. Capacity (section 6).
7. `liability >= withdrawn_value`.
8. `SPEND_VK` verifies `[context, state_root, approval_state.approved_root, nullifier_hash, be32(withdrawn_value), new_commitment]`.

Effects (all-or-nothing):

- Create `SpentNullifier {kind: 1}`. An existing account fails `init`, giving PRIV-03.
- Create `PendingChange {queue_seq: queue_tail, commitment: new_commitment, state: Pending}`; `queue_tail += 1`.
- Transfer `payout_amount` to destination and, if nonzero, `relayer_fee` to the relayer fee account.
- `liability -= withdrawn_value`; `cumulative_outflow += withdrawn_value`.
- Emit `PrivateSpend`.

#### 8.4.8 `exit_public(proof, state_root: [u8;32], nullifier_hash: [u8;32], value: u64, salt: [u8;32])`

Accounts: `refund_authority (s)`; `payer (s, m)` (may equal refund_authority); `pool_state (m)`; `vault (m)`; `vault_authority`; `destination (m)` = ATA(refund_authority, mint), initialized; `spent_nullifier (init, seeds)`; `token_program`, `system_program`.

Checks: canonical inputs; `state_root` known; `value > 0`; `label = derive(pool, mint, refund_authority, salt)`, nonzero; `liability >= value`; `EXIT_VK` verifies `[state_root, be32(label), be32(value), nullifier_hash]`. ApprovalState is not read. `deposits_paused` and config do not apply. The global stop does not disable exit (specification 6.4).

Effects: create `SpentNullifier {kind: 2}`; transfer `value` to destination; `liability -= value`; `cumulative_outflow += value`. Emit `PublicExit`. This works for original and change notes alike, because both carry the original label (PRIV-06, EXIT-01).

#### 8.4.9 `update_config(args: ConfigUpdate)`

`ConfigUpdate { deposits_paused: Option<bool>, min_deposit: Option<u64>, max_deposit: Option<u64>, liability_cap: Option<u64>, max_relayer_fee: Option<u64> }`.

Accounts: `config_authority (s)`; `pool_state (m)`.

Checks on the resulting values: `1 <= min_deposit <= max_deposit <= HARD_MAX_DEPOSIT`, `liability_cap <= HARD_LIABILITY_CAP`, `max_relayer_fee <= HARD_MAX_RELAYER_FEE`. A cap below the current liability is allowed; it blocks new deposits only. This instruction cannot change the mint, token program, vault, authorities, roots, queue, nullifiers or verifying keys, cannot move tokens and cannot affect exit. Emit `ConfigUpdated`.

v1 has no authority-rotation instruction. The upgrade authority remains a disclosed risk (specification 7.2, 7.2c).

### 8.5 Liability and solvency

`liability` = actual deposits received − refunds − spend withdrawals − exits. Pending deposits count. Tokens sent directly to the vault are surplus (`vault.amount - liability`). They create no note and no instruction can move them. The indexer replays events and checks `liability == Σ DepositQueued.amount − Σ DepositRefunded.amount − Σ PrivateSpend.withdrawn_value − Σ PublicExit.value` and `vault.amount >= liability` against finalized accounts.

### 8.6 Events (Anchor `#[event]`, `emit!`; public data only)

| Event | Fields |
|---|---|
| `PoolInitialized` | pool, pool_id, mint, token_program, vault, genesis_hash, empty_root, config_authority, approval_authority, protocol_version |
| `DepositQueued` | pool, queue_seq, amount, refund_authority, salt, label, precommitment, commitment, liability |
| `DepositRefunded` | pool, queue_seq, amount, refund_authority, destination, liability |
| `LeafInserted` | pool, queue_seq, kind (0 deposit, 1 change), leaf_index, commitment, new_root |
| `QueueItemSkipped` | pool, queue_seq |
| `ApprovedRootUpdated` | pool, version, approved_root |
| `PrivateSpend` | pool, nullifier_hash, state_root, approved_root, withdrawn_value, payout_amount, relayer_fee, destination_token_account, destination_owner, relayer (Option), valid_until_slot, new_commitment, change_queue_seq, liability |
| `PublicExit` | pool, nullifier_hash, state_root, label, value, refund_authority, destination, liability |
| `ConfigUpdated` | pool, deposits_paused, min_deposit, max_deposit, liability_cap, max_relayer_fee |

Field elements are emitted as `[u8;32]`. No note secret, value of a hidden note, task, agent, quote or account identifier is ever emitted.

### 8.7 Error codes (Anchor `#[error_code]`, starting at 6000 in this order)

`NonCanonicalFieldElement`, `ZeroValueNotAllowed`, `ZeroLabel`, `ZeroCommitment`, `InvalidGenesis`, `InvalidMint`, `InvalidTokenProgram`, `InvalidTokenAccount`, `InvalidVault`, `InvalidDestination`, `PoolMismatch`, `Unauthorized`, `NotUpgradeAuthority`, `DepositsPaused`, `DepositBelowMinimum`, `DepositAboveMaximum`, `LiabilityCapExceeded`, `TreeCapacityExhausted`, `QueueFull`, `TransferAmountMismatch`, `DepositNotPending`, `InvalidQueueItem`, `NotQueueHead`, `QueueItemNotPending`, `QueueItemNotRefunded`, `UnknownStateRoot`, `InvalidProof`, `PayoutZero`, `AmountOverflow`, `RelayerMismatch`, `RelayerFeeNotAllowed`, `RelayerFeeAccountMismatch`, `IntentExpired`, `IntentTooFarInFuture`, `LiabilityUnderflow`, `ConfigOutOfBounds`.

Off-chain services map these to specification 11 API codes (e.g. `InvalidMint` → `WRONG_MINT`). On-chain codes are not API codes.

---

## 9. Groth16 verification on Solana

### 9.1 Library

`groth16-solana` (Lightprotocol; the crates.io 0.2.0 package metadata declares MIT) pinned to crates.io `0.2.0` (the latest published version on 2026-10-14; T01 pins the exact version in `Cargo.lock`). API:

```rust
Groth16Verifier::<NR_INPUTS>::new(&proof_a: &[u8;64], &proof_b: &[u8;128], &proof_c: &[u8;64],
                                  &public_inputs: &[[u8;32]; NR_INPUTS], &VK: &Groth16Verifyingkey)?
    .verify()?   // MUST use verify(): it rejects inputs >= r (PublicInputGreaterThanFieldSize)
```

- `NR_INPUTS`: spend 6, insert 4, exit 4. `vk_ic.len() == NR_INPUTS + 1`.
- In 0.2.0 the `Groth16Verifyingkey` field is spelled `vk_gamme_g2`. Newer unreleased sources rename it. Use the spelling of the pinned version.
- The alt_bn128 syscall gate `A16q37opZdQMCbe5qJ6xpBB9usykfv8jZaMkxvZQi4GJ` is active on devnet (activation slot 235,872,000, queried 2026-10-14).

### 9.2 Proof and input byte encoding

From snarkjs `proof.json` (decimal, affine, with a trailing projective coordinate that is dropped):

```text
proof_a (64) = be32(A.x) || be32(q - A.y)        # A negated by the client; A.y = 0 is impossible for valid proofs
proof_b (128) = be32(B.x.c1) || be32(B.x.c0) || be32(B.y.c1) || be32(B.y.c0)
                # snarkjs pi_b = [[x.c0, x.c1], [y.c0, y.c1], ["1","0"]]; imaginary part first
proof_c (64) = be32(C.x) || be32(C.y)
public_inputs[i] = be32(publicSignals[i])        # order per section 7
q = 21888242871839275222246405745257275088696311157297823662689037894645226208583 (base field)
```

The VK uses the same rules: G1 is `x || y` and G2 is `c1 || c0` per coordinate. This matches `groth16-solana` `vk/circom.rs`. The program never negates; it passes `proof_a` as received. A wrong sign simply fails verification. An invalid point is rejected by the pairing syscall, and the program returns `InvalidProof`.

### 9.3 Verifying keys

VKs are embedded in the binary as `pub const SPEND_VK / INSERT_VK / EXIT_VK: Groth16Verifyingkey<'static>` in `programs/veilo-crypto/src/vk/{spend,insert,exit}.rs`, re-exported as `veilo_crypto::vk::{SPEND_VK, INSERT_VK, EXIT_VK}` with `{SPEND,INSERT,EXIT}_NR_INPUTS`, and wrapped by `veilo_crypto::{verify_spend, verify_insert, verify_exit}` (which call `verify()`). The `privacy-pool` program depends on the `veilo-crypto` crate. `nr_pubinputs` holds the number of public inputs; groth16-solana 0.2.0 does not read it. They are generated from snarkjs `verification_key.json` by a repository script (T06), never edited by hand. No instruction accepts a VK. The manifest records the SHA-256 of each `verification_key.json`, each generated `.rs` file, `.zkey`, `.wasm` and `.r1cs`. A circuit change requires a new program build and a new manifest (specification 7.2b, 24.1).

### 9.4 Compute budget (verifier measured M2; full instructions measured in T07)

The `groth16-solana` README reports 82,704 CU for 2 inputs, 91,448 for 4 and 108,762 for 8 (its benchmark, not ours). Pairing syscall costs are 36,364 + 12,121 per additional pair.

Measured in T06 (`pnpm tc -- sh circuits/scripts/measure-cu.sh`; LiteSVM 0.17.0 with the Agave 4.3 runtime; SBF program `programs/veilo-crypto/cu-bench` built with platform-tools v1.57 that calls `veilo_crypto::verify_*` once; results in `artifacts/circuits/verifier-cu.json`). Verifier instruction alone, excluding the 150 CU compute-budget instruction:

| Verifier | Public inputs | CU | Instruction data in the bench (1 + 256 + 32n) |
|---|---|---|---|
| spend | 6 | 108,399 | 449 B |
| insert | 4 | 97,098 | 385 B |
| exit | 4 | 97,101 | 385 B |

The same harness rejects every mutated case in `groth16-v1.json` on-chain (input + 1, input + r, non-negated A, swapped G2 halves).

| Instruction | Estimate | Client compute-unit limit |
|---|---|---|
| spend_private | ~100k verify + 2 transfers + 2 inits + SHA-256 | request 400,000 |
| insert_leaf | ~92k | request 300,000 |
| exit_public | ~92k + transfer + init | request 300,000 |
| deposit | transfer + 2 inits + SHA-256 + H3 (1,091) | request 100,000 |

Instruction-data size for spend is 8 + 256 + 96 + 154 = 514 bytes, comfortably below the 1,232-byte transaction limit with about 13 accounts. **M2** measures the actual numbers.

---

## 10. Deployment manifest (`artifacts/deployment/devnet-manifest.json`)

The manifest is generated by `deploy:devnet` and verified at startup. A mismatch stops proof and payment generation (specification 7.2b). JSON Schema (draft 2020-12):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://veilo.local/schemas/deployment-manifest-v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion","protocolVersion","encodingVersion","network","program","pool","token","crypto","trees","circuits","bounds","authorities","rootHistoryRule","signatures","createdAt"],
  "$defs": {
    "pubkey": {"type": "string", "pattern": "^[1-9A-HJ-NP-Za-km-z]{32,44}$"},
    "hex32": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
    "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
    "u64str": {"type": "string", "pattern": "^(0|[1-9][0-9]{0,19})$"},
    "fieldDec": {"type": "string", "pattern": "^(0|[1-9][0-9]{0,76})$"},
    "circuit": {
      "type": "object", "additionalProperties": false,
      "required": ["name","sourceSha256","circomVersion","compilerFlags","constraints","nPublic","publicInputOrder","r1csSha256","wasmSha256","zkeySha256","vkeyJsonSha256","vkRustSha256","ptau","setup"],
      "properties": {
        "name": {"enum": ["spend","insert","exit"]},
        "sourceSha256": {"$ref": "#/$defs/sha256"},
        "circomVersion": {"type": "string"},
        "compilerFlags": {"type": "array", "items": {"type": "string"}},
        "constraints": {"type": "integer", "minimum": 1},
        "nPublic": {"type": "integer", "minimum": 1},
        "publicInputOrder": {"type": "array", "items": {"type": "string"}},
        "r1csSha256": {"$ref": "#/$defs/sha256"},
        "wasmSha256": {"$ref": "#/$defs/sha256"},
        "zkeySha256": {"$ref": "#/$defs/sha256"},
        "vkeyJsonSha256": {"$ref": "#/$defs/sha256"},
        "vkRustSha256": {"$ref": "#/$defs/sha256"},
        "ptau": {"type": "object", "required": ["file","sha256","power","source"], "properties": {"file": {"type": "string"}, "sha256": {"$ref": "#/$defs/sha256"}, "power": {"type": "integer"}, "source": {"type": "string"}}},
        "setup": {"type": "object", "required": ["kind","contributions","beacon"], "properties": {"kind": {"const": "development"}, "contributions": {"type": "array"}, "beacon": {"type": "string"}}}
      }
    }
  },
  "properties": {
    "schemaVersion": {"const": 1},
    "protocolVersion": {"const": 1},
    "encodingVersion": {"const": "v1"},
    "network": {"type": "object", "additionalProperties": false, "required": ["cluster","caip2","genesisHash","genesisHashHex"],
      "properties": {"cluster": {"const": "devnet"}, "caip2": {"const": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"}, "genesisHash": {"const": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"}, "genesisHashHex": {"const": "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab"}}},
    "program": {"type": "object", "required": ["programId","programDataAddress","upgradeAuthority","binarySha256","anchorVersion","solanaToolsVersion","rustToolchain","deploySignature"],
      "properties": {"programId": {"$ref": "#/$defs/pubkey"}, "programDataAddress": {"$ref": "#/$defs/pubkey"}, "upgradeAuthority": {"anyOf": [{"$ref": "#/$defs/pubkey"}, {"type": "null"}]}, "binarySha256": {"$ref": "#/$defs/sha256"}, "anchorVersion": {"type": "string"}, "solanaToolsVersion": {"type": "string"}, "rustToolchain": {"type": "string"}, "groth16SolanaVersion": {"type": "string"}, "deploySignature": {"type": "string"}}},
    "pool": {"type": "object", "required": ["poolId","poolState","vaultAuthority","vault","approvalState","initSignature"],
      "properties": {"poolId": {"$ref": "#/$defs/hex32"}, "poolState": {"$ref": "#/$defs/pubkey"}, "vaultAuthority": {"$ref": "#/$defs/pubkey"}, "vault": {"$ref": "#/$defs/pubkey"}, "approvalState": {"$ref": "#/$defs/pubkey"}, "initSignature": {"type": "string"}}},
    "token": {"type": "object", "required": ["mint","decimals","tokenProgram","mintKind","freezeAuthority"],
      "properties": {"mint": {"$ref": "#/$defs/pubkey"}, "decimals": {"const": 6}, "tokenProgram": {"const": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}, "mintKind": {"enum": ["devnet-usdc","demo-mint"]}, "freezeAuthority": {"anyOf": [{"$ref": "#/$defs/pubkey"}, {"type": "null"}]}}},
    "crypto": {"type": "object", "required": ["curve","scalarField","proofSystem","hash","labelDomain","intentDomain","contextHash","vectorsFile","vectorsSha256"],
      "properties": {"curve": {"const": "bn254"}, "scalarField": {"const": "21888242871839275222246405745257275088548364400416034343698204186575808495617"}, "proofSystem": {"const": "groth16"},
        "hash": {"type": "object", "properties": {"name": {"const": "poseidon-circomlib"}, "sbox": {"const": 5}, "fullRounds": {"const": 8}, "partialRounds": {"type": "object"}, "arities": {"const": [2,3]}}},
        "labelDomain": {"const": "veilo/label/v1"}, "intentDomain": {"const": "veilo/intent/v1"}, "contextHash": {"const": "sha256-first31-be"},
        "vectorsFile": {"type": "string"}, "vectorsSha256": {"$ref": "#/$defs/sha256"}}},
    "trees": {"type": "object", "required": ["commitmentDepth","approvedDepth","rootHistory","emptyRoot","capacity","changeReserve","queueMaxLiveDeposits"],
      "properties": {"commitmentDepth": {"type": "integer"}, "approvedDepth": {"type": "integer"}, "rootHistory": {"type": "integer"}, "emptyRoot": {"$ref": "#/$defs/fieldDec"}, "capacity": {"type": "integer"}, "changeReserve": {"type": "integer"}, "queueMaxLiveDeposits": {"type": "integer"}}},
    "circuits": {"type": "object", "required": ["spend","insert","exit"], "properties": {"spend": {"$ref": "#/$defs/circuit"}, "insert": {"$ref": "#/$defs/circuit"}, "exit": {"$ref": "#/$defs/circuit"}}},
    "bounds": {"type": "object", "required": ["minDeposit","maxDeposit","liabilityCap","maxRelayerFee","maxIntentSlots","hardMaxDeposit","hardLiabilityCap","hardMaxRelayerFee"],
      "properties": {"minDeposit": {"$ref": "#/$defs/u64str"}, "maxDeposit": {"$ref": "#/$defs/u64str"}, "liabilityCap": {"$ref": "#/$defs/u64str"}, "maxRelayerFee": {"$ref": "#/$defs/u64str"}, "maxIntentSlots": {"const": 750}, "hardMaxDeposit": {"$ref": "#/$defs/u64str"}, "hardLiabilityCap": {"$ref": "#/$defs/u64str"}, "hardMaxRelayerFee": {"$ref": "#/$defs/u64str"}}},
    "authorities": {"type": "object", "required": ["deployer","configAuthority","approvalAuthority","sponsor","relayer"],
      "properties": {"deployer": {"$ref": "#/$defs/pubkey"}, "configAuthority": {"$ref": "#/$defs/pubkey"}, "approvalAuthority": {"$ref": "#/$defs/pubkey"}, "sponsor": {"$ref": "#/$defs/pubkey"}, "relayer": {"$ref": "#/$defs/pubkey"}}},
    "rootHistoryRule": {"const": "spend/exit accept any of the newest 32 commitment roots; insert accepts only the current root; spend accepts only the current approved root"},
    "signatures": {"type": "object", "additionalProperties": {"type": "string"}},
    "createdAt": {"type": "string", "format": "date-time"}
  }
}
```

---

## 11. Cross-language test vectors

File: `artifacts/vectors/v1.json` (encoding version `v1`). Field elements are decimal strings, bytes are lowercase hex, and u64 values are decimal strings. The file is generated by the TypeScript reference in `packages/privacy-sdk` and is never hand-edited. Its SHA-256 goes into the manifest.

Commands:

- `pnpm vectors:generate`: writes `artifacts/vectors/v1.json`. It refuses to overwrite a differing committed file unless `--force-protocol-change` is passed.
- `pnpm vectors:check`: runs every checker below and fails on any mismatch.

| Section key | Contents | Checked by |
|---|---|---|
| `field` | `r`, `be32` encodings of 0, 1, 1000000, 2^64−1, r−1; non-canonical rejects: `be32(r)`, `ff…ff`, 31-byte and 33-byte inputs | TS, Rust |
| `poseidon` | H2(1,2) = `7853200120776062878684798364095072458815029376092732009249414926327459813530`; H2(0,0); H3(1,2,3); H3(0,0,0); H2(r−1, r−1) | TS (circomlibjs), circom witness, Rust (light-poseidon and `solana-poseidon` off-chain path) |
| `label` | ≥2 cases incl. section 4 draft and a case with real devnet mint bytes: inputs, preimage hex, SHA-256, label | TS, Rust, independent Python stdlib script |
| `intent` | ≥3 cases (section 5 drafts + max u64 amounts): fields, `intent_bytes` hex, SHA-256, context; negative cases for rule violations | TS, Rust, Python |
| `note` | secrets, value, label → precommitment, commitment, nullifier_hash; a change derivation with remainder 0 and > 0 | TS, circom, Rust (commitment via `hashv`) |
| `zeros` | `Z[0..16]`; `emptyRoot = Z[16]` | TS, circom, Rust (program `EMPTY_ROOT`) |
| `merkle` | trees with leaves at indices 0, 1 and 5: siblings, path bits, root; an approved-tree path for a label | TS, circom, Rust |
| `insert` | oldRoot, newRoot, leafIndex, leaf, siblings for 3 sequential appends incl. one after a skipped refunded deposit | TS, circom, Rust |
| `keys` | HKDF outputs for seeds `00..1f` and `ff`×32 at indices 0, 1, 7, 1000000 (all four info strings) | TS, Python |
| `pda` | seeds and expected addresses/bumps for every section 8.1 account under a fixed test program id whose raw bytes are `aa`×32, with `pool_id = 01`×32 | TS (@solana/kit), Rust |
| `groth16` (separate file `artifacts/vectors/groth16-v1.json`, generated after setup) | per circuit: snarkjs proof + publicSignals, converted `proof_a/b/c` bytes, `public_inputs` bytes, expected valid; mutated cases (signal+1, signal+r, non-negated A, swapped G2 halves) expected invalid | snarkjs verify, Rust `groth16-solana` in program tests |

Checkers (all run by `pnpm vectors:check`; `pnpm test:circuits` also runs the `groth16` file):

| Language | Location |
|---|---|
| TypeScript reference | `packages/privacy-sdk/src/vectors.ts`, `packages/privacy-sdk/scripts/vectors.ts` (byte-identical regeneration) |
| Python stdlib | `packages/privacy-sdk/scripts/check_vectors.py` (label, intent, keys) |
| circom | `circuits/test/vectors.test.ts` with test harnesses `circuits/test/harness/{hashes,merkle16}.circom` and the main circuits |
| Rust | `programs/veilo-crypto/tests/vectors.rs` (`solana-sha256-hasher`, `solana-poseidon` off-chain path cross-checked against `light-poseidon` `new_circom`, `solana-pubkey` PDAs) and `tests/groth16.rs` (`groth16-solana` 0.2.0 `verify()`) |

The section 4 and 5 draft known answers and `poseidon[0]` were reproduced exactly by all checkers; no hand-computed value needed correction. snarkjs 0.7.6 `groth16.verify` also rejects a public signal `x + r` (it does not reduce modulo r). The SDK still checks canonicality before verifying.

Rule: an implementation is correct only if it reproduces every vector. Vectors are never edited to make a test pass (CLAUDE.md, specification 15).

---

## 12. Protocol design decisions

| # | Reference | Veilo v1 | Reason |
|---|---|---|---|
| 1 | BLS12-381, Poseidon255, `circom --prime bls12381` | BN254, circomlib Poseidon | Solana has alt_bn128 and Poseidon syscalls only for BN254 (specification 7.1) |
| 2 | blake2b_256 for label/context | SHA-256 | `sol_sha256` syscall; one primitive for label and context |
| 3 | Label from pool NFT, deposit tx id/output index, refund key hash; derived at Insert | Label from PoolState, mint, refund pubkey, salt; derived at deposit | specification 7.2a fixed construction; no UTXO ids on Solana |
| 4 | `nullifierHash = H1(nullifier)` | `H2(nullifier_secret, label)` + per-pool PDA | specification requires pool-scoped nullifier; label carries pool binding with no extra public input |
| 5 | Nullifier set in a Merkle Patricia Forestry root | One `SpentNullifier` PDA per hash | Account `init` gives atomic uniqueness on Solana |
| 6 | Depth 32, insert batch 4 with in-circuit H3 of deposits | Depth 16, one leaf per insert; deposit H3 computed on-chain via syscall | specification 7.2 prototype; Poseidon is cheap on Solana (the reference avoided it for Cardano cost) |
| 7 | Multiple payouts, bps fees, crank fee, fees_accrued, CollectFees, submitter keeps `withdrawn − paid − fee` | One payout + optional relayer fee, `withdrawn == payout + fee` exactly, no protocol fee, no treasury | specification 6.2a debit equality; zero-fee default; no sweep |
| 8 | `valid_until` POSIX ms vs tx validity interval | `valid_until_slot` checked against `Clock.slot`, ≤ 750 slots ahead | specification 7.2a/7.2b |
| 9 | Intent binds pool + payout addresses | Also binds program id, genesis, mint, destination owner | specification 7.2 |
| 10 | Root history 16 | 32 | specification 7.2b |
| 11 | Ragequit label from deposit ref and refund key | Exit label re-derived from signer + disclosed salt, payout only to signer's ATA | specification 7.2a |
| 12 | VKs as immutable script parameters | VKs compiled into an upgradeable program | Solana model; upgrade authority disclosed |
| 13 | Admin multisig, ASP operator multisig | Single config authority and single approval authority keys | Prototype scope; disclosed |
| 14 | Circuit public outputs first | All public signals are inputs in declared order | Removes ordering ambiguity |
| 15 | Deposits refundable while unabsorbed via UTXO spend | `refund_pending_deposit` tombstone + `skip_refunded_deposit` | Deterministic queue (specification 7.2b) |
| 16 | Pool cap excludes pending deposits | Pending deposits count toward cap | specification 7.2c |

The reference's Cardano validators, byte orders, NFT genesis, BLS artifacts and test-vector answers are not reused (specification 23).

---

## 13. Open items (M2 measure or decide before trusted artifacts)

1. ~~Full-instruction CU, transaction size, lookup table.~~ Measured in T07: spend_private ≤139,970 CU (400k suffices), largest transaction 1,152 bytes, no lookup table required (see changelog and docs/deployment.md).
2. ~~Constraint counts, proving time and ptau power; depth 16.~~ Measured in T06 (section 7.4). Native (C++) witness generation was not measured; WASM witness generation takes about 50 ms.
3. Rent cost of never-closed PDAs (PendingDeposit 234 B, PendingChange 130 B, SpentNullifier 50 B, SeenPrecommitment 49 B), measured in T07: 0.00375 SOL per deposit, 0.00303 SOL per spend, 0.00124 SOL per exit. A later closure design would need a protocol revision.
4. `QUEUE_MAX_LIVE_DEPOSITS = 64` and `CHANGE_RESERVE = 1024` under concurrency tests.
5. ~~Confirm circom public-signal order.~~ Done in T06: `circuits/test/artifacts.test.ts` asserts that wires 1..n of each compiled `.sym` are the declared public inputs in order, and every proof test asserts that snarkjs `publicSignals` equal the witness's expected order.
6. `groth16-solana` 0.2.0 has no audit claim in its README (it is provided "as-is"). light-poseidon reports a Veridise audit. Record this in docs/security.md.
7. The program cannot read the genesis hash on-chain. Binding relies on the compile-time `EXPECTED_GENESIS`, the stored value and off-chain RPC checks. Program-id reuse on another cluster is mitigated only by those checks.
8. Devnet USDC freeze authority can freeze the vault. Disclose this, or use a demo mint without a freeze authority (labeled, specification 8.1).
9. The insert crank is a single submitter. Concurrent insert proofs race on `current_root`, and the loser must re-prove.
10. Event log truncation: switch to `emit_cpi!` if logs prove unreliable for the indexer.
11. If the Poseidon syscall misbehaves on the target runtime, fall back to computing the deposit leaf `H3(v, l, x)` in the insert circuit, with `leaf` replaced by `value, label, precommitment` and 6 public inputs. That fallback is a protocol revision.

---

## 14. Changelog

| Date | Change | Kind |
|---|---|---|
| 2026-10-15 (T05/T06) | `artifacts/vectors/v1.json` generated; the TypeScript, Python, circom and Rust checkers reproduce it; draft known answers confirmed unchanged | vectors (no semantic change) |
| 2026-10-15 (T06) | Section 7.4: Phase 1 is a locally generated, deterministic development ptau (power 15) instead of the Hermez file; Phase 2 is a public beacon per circuit, with an optional secret contribution. Measured sizes and timings recorded | setup provenance and M2 measurements; v1 semantics unchanged |
| 2026-10-15 (T06) | Section 9.3: verifying keys are generated into the `veilo-crypto` crate (`programs/veilo-crypto/src/vk/`) rather than `programs/privacy-pool/src/vk/`, and the program uses them through that crate | code location only |
| 2026-10-15 (T06) | Section 9.1: groth16-solana 0.2.0 is MIT-licensed per its crates.io metadata (the draft said Apache-2.0) | fact correction |
| 2026-10-15 (T06) | Section 9.4: verifier compute units measured in LiteSVM | M2 measurement |
| 2026-10-15 (T07) | Section 9.4 / 13 item 1 / 13 item 3: full-instruction compute units, transaction sizes, account rent and deployment cost measured in LiteSVM (`artifacts/program/measurements.json`, docs/deployment.md "Program"). spend_private 137,800–139,970 CU, insert_leaf ≈109k, exit_public 121,255, deposit ≤33,086; the recommended client limits hold. Largest transaction 1,152 bytes; an address lookup table is optional, not required | M2 measurement |
| 2026-10-15 (T07) | Sections 8.4.2, 8.4.3, 8.4.7, 8.4.8: token movements use SPL Token `Transfer`, not `TransferChecked`, because the frozen account lists carry no mint account. Equivalent for the original SPL Token program: the program checks the mint of every source/destination/vault account itself, and deposit still verifies the received amount by reloading the vault | implementation clarification; accounts and encodings unchanged |
| 2026-10-15 (T07) | Sections 2.2, 8.4.2, 8.4.7, 8.4.8: PendingDeposit, SeenPrecommitment, SpentNullifier and PendingChange are created by the handler after every check (canonical inputs, then proof verification), not by Anchor `init`, so no PDA is derived from a field argument before its canonical check. A replayed nullifier or precommitment fails in the System Program with `AccountAlreadyInUse` (custom error 0), exactly as `init` would | implementation clarification |
| 2026-10-15 (T07) | Section 5.2 rule 3: when `intent.relayer` is None the `relayer` and `relayer_fee_account` slots are ignored (clients pass the program id for absent optional accounts) | clarification |
| 2026-10-15 (T07) | Section 8.2 `EXPECTED_GENESIS`: both builds also reject the all-zero genesis hash; the default Cargo feature is `devnet`, and building with both or neither of `devnet`/`localnet` is a compile error | clarification |

---

## Appendix A. Service rules outside the pool program

These rules are enforced by Veilo services, not by `privacy-pool`, and are not part of protocol v1: changing them needs no new vectors, circuit artifacts or deployment manifest.

### A.1 Devnet swap transaction (relayer co-signing)

A swap is spent from a fresh wallet funded by `spend_private`, after control has recorded `sign_merchant` for the purchase. The relayer (`POST /swaps`, wallet credential) co-signs as fee payer only a v0 transaction with no address lookup tables, the sponsor as account 0, a valid fresh-wallet signature and exactly these instructions:

| # | Program | Rule |
|---|---|---|
| 1 | Compute Budget | `SetComputeUnitLimit` (data tag 2, 5 bytes, no accounts) |
| 2 | Associated Token | `CreateIdempotent` (data `[1]`): payer sponsor, ATA = fresh wallet's wrapped-SOL account, owner fresh wallet, mint wrapped SOL |
| 3 | Orca Whirlpool `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | One `swapV2`; authority fresh wallet; whirlpool `5GPCnpWwoDayCP5FVCJT1cS7dePufC5FrjPTVvPoUYnm`; mints wrapped SOL and the workspace USDC mint; the fresh wallet's own wrapped-SOL and USDC accounts; `aToB = false`, `amountSpecifiedIsInput = true`, positive amount and minimum output |
| 4 | SPL Token | `CloseAccount` (data `[9]`) of the wrapped-SOL account to the stated destination, authority fresh wallet |
| 5 | SPL Token | `CloseAccount` of the emptied USDC account with its rent to the sponsor |

Before signing, the wallet additionally requires that instruction 3 sells exactly the fresh wallet's current USDC balance (at least the funded amount) for exactly the quoted minimum output, with slippage `SWAP_SLIPPAGE_BPS = 100`. The destination is the wallet's `OWNER_RECOVERY_ADDRESS`. The relayer's sponsor cap counts every submitted swap at its worst case (wrapped-SOL rent plus two signature fees).

### A.2 Swap states in control

| Event | Merchant leg | Fulfilment | Recovery |
|---|---|---|---|
| `sign_merchant` recorded | `not_started` → `signed` | — | — |
| Swap finalized (fee read from the finalized transaction) | `signed` → `finalized` | `not_started` → `in_progress` → `delivered` | — |
| Swap failed on chain, expired, or refused by the relayer before co-signing | `signed` → `expired_unsettled` | `not_started` → `abandoned` | `recoverable` |
| Owner recovery proves no swap was signed (`POST /internal/wallet/purchases/:id/swap-not-signed`, wallet credential) | `signed` → `expired_unsettled`, reason `swap_never_signed` | `not_started` → `abandoned` | then `recoverable` |
| Wallet refuses (`recovery_required`) | stays `signed` | — | — |

The wallet records `swap.signature_produced` before the fresh wallet signs; with that record or a stored swap present, the never-signed route is refused (`SETTLEMENT_UNCERTAIN`).

### A.3 Templated connector tools

A templated tool approval records `template = { upstream, upstreamSha256, codeSha256 }`, where `upstreamSha256` is the digest of the live upstream tool definition (for CoinGecko, `execute` on `mcp.api.coingecko.com`) and

```text
codeSha256 = SHA-256("veilo:mcp-template:v1\n" || canonicalJson({name, host, upstream, code}))
```

over the template in `packages/contracts/src/marketplace/mcp-templates.ts`. A call validates the agent's arguments against the template's schema, inserts them as JSON literals into the fixed code and sends only `{ code }` to the upstream tool. A changed template, host or upstream digest needs a new approval; code-execution tools themselves are refused when proposed, attached or called.

---

## References

- circomlib Poseidon template (round table, t = nInputs + 1): https://github.com/iden3/circomlib/blob/master/circuits/poseidon.circom
- circomlibjs reference Poseidon (bn128, N_ROUNDS_F = 8, N_ROUNDS_P table): https://github.com/iden3/circomlibjs/blob/main/src/poseidon_reference.js
- light-poseidon (Circom-compatible params, widths 2–13, Veridise audit, Apache-2.0): https://github.com/Lightprotocol/light-poseidon
- light-poseidon source (input-length / modulus validation, errors): https://github.com/Lightprotocol/light-poseidon/blob/main/light-poseidon/src/lib.rs
- light-poseidon tests (circomlibjs-derived cases; `new_circom(2)` hash of 1, 2): https://github.com/Lightprotocol/light-poseidon/blob/main/light-poseidon/tests/bn254_fq_x5.rs
- solana-poseidon crate (`hashv`, `Parameters::Bn254X5`, `Endianness`, `sol_poseidon`): https://docs.rs/solana-poseidon/latest/solana_poseidon/ and https://docs.rs/crate/solana-poseidon/latest/source/src/lib.rs
- Solana syscall reference (`sol_poseidon` feature-gated): https://solana.com/docs/core/programs/syscall-reference.md
- Agave feature IDs (`enable_poseidon_syscall`, `enable_alt_bn128_syscall`): https://github.com/anza-xyz/agave/blob/v2.0/sdk/src/feature_set.rs
- Agave syscall costs (Poseidon 61·n²+542, SHA-256 85+1/byte, bn128 pairing 36,364 + 12,121): https://github.com/anza-xyz/agave/blob/master/program-runtime/src/execution_budget.rs
- Devnet feature accounts and genesis hash: JSON-RPC `getMultipleAccounts` / `getGenesisHash` / `getAccountInfo` against https://api.devnet.solana.com, 2026-10-14 (slot ≈ 511,003,583)
- groth16-solana repository and README (CU benchmarks, big-endian inputs; crates.io 0.2.0 declares MIT): https://github.com/Lightprotocol/groth16-solana
- groth16-solana 0.2.0 API (`new`, `verify` vs `verify_unchecked`, `Groth16Verifyingkey`): https://docs.rs/groth16-solana/0.2.0/groth16_solana/groth16/struct.Groth16Verifier.html and https://docs.rs/crate/groth16-solana/0.2.0/source/src/groth16.rs
- groth16-solana crate versions: https://crates.io/crates/groth16-solana
- groth16-solana snarkjs VK conversion (G1 x‖y BE, G2 c1‖c0 BE): https://github.com/Lightprotocol/groth16-solana/blob/master/src/vk/circom.rs
- groth16-solana proof-A negation in tests: https://github.com/Lightprotocol/groth16-solana/blob/master/src/groth16.rs
- circom main component and public inputs: https://docs.circom.io/circom-language/the-main-component/
- Solana PDAs and CPI: https://solana.com/docs/core/pda, https://solana.com/docs/core/cpi
