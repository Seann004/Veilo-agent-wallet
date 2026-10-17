// Local-validator funding helpers: faucet airdrops and test-USDC minting with the local mint
// authority. Refuses any RPC that is not loopback.
import { AccountRole, address, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { DEMO_TOKEN_MINT, isLoopbackUrl } from "@veilo/contracts";
import { ata, awaitTx, createAtaIdempotentIx, decodeTokenAccount, getAccount, lamportsOf, signAndSend, sleep, TOKEN_PROGRAM, type Rpc } from "../devnet/lib";

export function assertLoopback(rpcUrl: string): void {
  if (!isLoopbackUrl(rpcUrl)) throw new Error("local stack helpers accept only a loopback RPC");
}

export async function airdrop(rpc: Rpc, rpcUrl: string, to: string, amount: bigint): Promise<void> {
  assertLoopback(rpcUrl);
  const before = await lamportsOf(rpc, to);
  // Accounts already funded (a reused stack) are topped up only when they run low.
  if (before >= amount / 2n) return;
  const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [to, Number(amount - before)] }) });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`airdrop failed: ${body.error.message}`);
  const deadline = Date.now() + 60_000;
  while ((await lamportsOf(rpc, to)) <= before) {
    if (Date.now() > deadline) throw new Error(`airdrop to ${to} not finalized within 60 s`);
    await sleep(1_000);
  }
}

function mintToIx(mint: Address, destination: Address, authority: Address, amount: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 7;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: destination, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

/** Tops the owner's canonical ATA up to `target` base units (creates the ATA if missing). */
export async function mintTestUsdc(rpc: Rpc, rpcUrl: string, payer: KeyPairSigner, mintAuthority: KeyPairSigner, owner: string, target: bigint): Promise<bigint> {
  assertLoopback(rpcUrl);
  const mint = address(DEMO_TOKEN_MINT);
  const dest = await ata(owner, mint);
  const acct = await getAccount(rpc, dest);
  const balance = acct ? decodeTokenAccount(acct.data).amount : 0n;
  if (balance >= target) return balance;
  const sent = await signAndSend(rpc, payer, [mintAuthority], [createAtaIdempotentIx(payer.address, dest, address(owner), mint), mintToIx(mint, dest, mintAuthority.address, target - balance)], () => undefined);
  const r = await awaitTx(rpc, sent);
  if (r.state !== "finalized" || r.outcome.err !== null) throw new Error(`mint to ${owner} did not finalize: ${r.state}`);
  return target;
}

/** Creates an ATA (idempotent) and waits for finality. */
export async function ensureAta(rpc: Rpc, payer: KeyPairSigner, owner: string): Promise<Address> {
  const mint = address(DEMO_TOKEN_MINT);
  const dest = await ata(owner, mint);
  if (await getAccount(rpc, dest)) return dest;
  const sent = await signAndSend(rpc, payer, [], [createAtaIdempotentIx(payer.address, dest, address(owner), mint)], () => undefined);
  const r = await awaitTx(rpc, sent);
  if (r.state !== "finalized" || r.outcome.err !== null) throw new Error(`ATA for ${owner} did not finalize`);
  return dest;
}

export async function tokenBalance(rpc: Rpc, owner: string): Promise<bigint> {
  const acct = await getAccount(rpc, await ata(owner, DEMO_TOKEN_MINT));
  return acct ? decodeTokenAccount(acct.data).amount : 0n;
}
