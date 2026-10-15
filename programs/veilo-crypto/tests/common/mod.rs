#![allow(dead_code)]

use std::path::PathBuf;

use serde_json::Value;

pub fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
}

pub fn load_json(rel: &str) -> Value {
    let path = repo_path(rel);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("valid JSON")
}

pub fn hex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd hex length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

pub fn hex32(s: &str) -> [u8; 32] {
    hex(s).try_into().expect("32 bytes")
}

pub fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Decimal string to a 32-byte big-endian integer (panics if it does not fit).
pub fn dec32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for ch in s.bytes() {
        assert!(ch.is_ascii_digit(), "decimal digit");
        let mut carry = (ch - b'0') as u32;
        for byte in out.iter_mut().rev() {
            let v = (*byte as u32) * 10 + carry;
            *byte = (v & 0xff) as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0, "decimal overflows 32 bytes");
    }
    out
}

pub fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}

pub fn u64v(v: &Value) -> u64 {
    s(v).parse().expect("u64")
}
