"""Independent stdlib-only check of the label, intent and key sections of artifacts/vectors/v1.json.

usage: python3 check_vectors.py artifacts/vectors/v1.json
"""

import hashlib
import hmac
import json
import sys

R = 21888242871839275222246405745257275088548364400416034343698204186575808495617
U64_MAX = 2**64 - 1
MAX_INTENT_SLOTS = 750


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def first31(b: bytes) -> int:
    return int.from_bytes(sha256(b)[:31], "big")


def u64be(x: int) -> bytes:
    assert 0 <= x <= U64_MAX
    return x.to_bytes(8, "big")


def hkdf_sha256(ikm: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(b"\x00" * 32, ikm, hashlib.sha256).digest()  # RFC 5869: empty salt = HashLen zeros
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
        i += 1
    return okm[:length]


def check_labels(v):
    for c in v["label"]:
        pre = b"veilo/label/v1" + b"".join(bytes.fromhex(c[k]) for k in ("pool", "mint", "refundAuthority", "salt"))
        assert len(pre) == 142
        assert pre.hex() == c["preimage"], c["name"]
        assert sha256(pre).hex() == c["sha256"], c["name"]
        label = first31(pre)
        assert label != 0 and label < R
        assert str(label) == c["label"], c["name"]
        assert label.to_bytes(32, "big").hex() == c["labelBe32"], c["name"]
    return len(v["label"])


def opt(c, key):
    return None if c[key] is None else bytes.fromhex(c[key])


def intent_bytes(c) -> bytes:
    relayer, fee_acct = opt(c, "relayer"), opt(c, "relayerFeeTokenAccount")
    out = (
        b"veilo/intent/v1"
        + b"".join(bytes.fromhex(c[k]) for k in
                   ("programId", "pool", "genesisHash", "mint", "destinationTokenAccount", "destinationOwner"))
        + u64be(int(c["payoutAmount"]))
        + u64be(int(c["relayerFee"]))
        + (b"\x01" if relayer is not None else b"\x00")
        + (relayer or b"\x00" * 32)
        + (fee_acct or b"\x00" * 32)
        + u64be(int(c["validUntilSlot"]))
    )
    assert len(out) == 296
    return out


def intent_error(c, max_fee: int, slot: int):
    payout, fee, until = int(c["payoutAmount"]), int(c["relayerFee"]), int(c["validUntilSlot"])
    relayer, fee_acct = c["relayer"], c["relayerFeeTokenAccount"]
    if payout == 0:
        return "PayoutZero"
    if payout + fee > U64_MAX:
        return "AmountOverflow"
    if relayer is None:
        if fee != 0:
            return "RelayerFeeNotAllowed"
        if fee_acct is not None:
            return "RelayerFeeAccountMismatch"
    elif (fee > 0) != (fee_acct is not None):
        return "RelayerFeeAccountMismatch"
    if fee > max_fee:
        return "RelayerFeeNotAllowed"
    if slot > until:
        return "IntentExpired"
    if until - slot > MAX_INTENT_SLOTS:
        return "IntentTooFarInFuture"
    return None


def check_intents(v):
    for c in v["intent"]["valid"]:
        b = intent_bytes(c)
        assert b.hex() == c["intentBytes"], c["name"]
        assert sha256(b).hex() == c["sha256"], c["name"]
        ctx = first31(b)
        assert str(ctx) == c["context"] and ctx.to_bytes(32, "big").hex() == c["contextBe32"], c["name"]
        assert str(int(c["payoutAmount"]) + int(c["relayerFee"])) == c["withdrawnValue"], c["name"]
    for c in v["intent"]["invalid"]:
        got = intent_error(c, int(c["maxRelayerFee"]), int(c["currentSlot"]))
        assert got == c["error"], (c["name"], got)
    b = v["intent"]["boundary"]
    base = v["intent"]["valid"][0]
    assert base["validUntilSlot"] == b["validUntilSlot"]
    for slot in b["acceptedCurrentSlots"]:
        assert intent_error(base, 0, int(slot)) is None
    return len(v["intent"]["valid"]) + len(v["intent"]["invalid"])


def check_keys(v):
    for c in v["keys"]:
        seed, i = bytes.fromhex(c["seed"]), c["index"]
        okm_n = hkdf_sha256(seed, f"veilo/nullifier/v1/{i}".encode(), 64)
        okm_s = hkdf_sha256(seed, f"veilo/secret/v1/{i}".encode(), 64)
        assert okm_n.hex() == c["nullifierOkm"] and okm_s.hex() == c["secretOkm"]
        assert str(int.from_bytes(okm_n, "big") % R) == c["nullifierSecret"]
        assert str(int.from_bytes(okm_s, "big") % R) == c["noteSecret"]
        assert hkdf_sha256(seed, f"veilo/salt/v1/{i}".encode(), 32).hex() == c["salt"]
        assert hkdf_sha256(seed, f"veilo/onetime/v1/{i}".encode(), 32).hex() == c["onetimeSeed"]
    return len(v["keys"])


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        v = json.load(f)
    assert v["version"] == "v1"
    n = check_labels(v) + check_intents(v) + check_keys(v)
    print(f"Python: label/intent/keys vectors reproduced ({n} cases)")


if __name__ == "__main__":
    main()
