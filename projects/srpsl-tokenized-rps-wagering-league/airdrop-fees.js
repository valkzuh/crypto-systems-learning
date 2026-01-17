/*
 * FILE: airdrop-fees.js
 *
 * Purpose:
 * - Distribute a portion of collected fees to holders on a schedule.
 *
 * Summary:
 * - Reads holder balances from EXPORT_URL.
 * - Reads fee wallet token balance to compute the new fee delta.
 * - Sends a pro-rata distribution to recipients.
 * - Persists last run state in airdrop-state.json.
 */

import fs from "fs";
import path from "path";
import bs58 from "bs58";
import { fileURLToPath } from "url";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getMint,
  transferChecked,
} from "@solana/spl-token";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_PATH = path.join(__dirname, "airdrop-state.json");

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonSafe(p, obj) {
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error(" Failed writing airdrop state:", e);
  }
}

function loadKeypairFromEnv(jsonStr, b58Str) {
  if (jsonStr && String(jsonStr).trim()) {
    const arr = JSON.parse(String(jsonStr));
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  if (b58Str && String(b58Str).trim()) {
    const sec = bs58.decode(String(b58Str));
    return Keypair.fromSecretKey(sec);
  }
  return null;
}

async function fetchExport(EXPORT_URL) {
  const res = await fetch(String(EXPORT_URL));
  if (!res.ok) throw new Error(`Export fetch failed: ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Export error: ${json.error || "unknown"}`);
  return json;
}

function toBaseUnitsFloatTokens(tokens, decimals) {
// exported "balance" can be decimals
  const s = String(tokens ?? "0").trim();
  if (!s || s === "0") return 0n;

  const neg = s.startsWith("-");
  const t = neg ? s.slice(1) : s;

  const [whole, fracRaw = ""] = t.split(".");
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  const baseStr = `${whole || "0"}${frac}`;
  const base = BigInt(baseStr.replace(/^0+/, "") || "0");
  return neg ? -base : base;
}

function baseToUi(base, decimals) {
  const neg = base < 0n;
  const x = neg ? -base : base;
  const pow = 10n ** BigInt(decimals);
  const whole = x / pow;
  const frac = x % pow;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return neg ? `-${out}` : out;
}

function bigFloorDiv(a, b) {
// integer division
  return a / b;
}

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function setupFeeAirdrop({
  EXPORT_URL,
  RPC_URL,
  FEE_WALLET,
  TOKEN_DECIMALS,

  AIRDROP_EVERY_MS,
  AIRDROP_TREASURY_SECRET_JSON,
  AIRDROP_TREASURY_SECRET_B58,

  AIRDROP_MIN_POOL_TOKENS,
  AIRDROP_CONCURRENCY,
}) {
  if (!EXPORT_URL || !RPC_URL) throw new Error("setupFeeAirdrop missing EXPORT_URL/RPC_URL");
  if (!FEE_WALLET) throw new Error("setupFeeAirdrop missing FEE_WALLET");

  const connection = new Connection(String(RPC_URL), "confirmed");

  const everyMs = Number(AIRDROP_EVERY_MS ?? 3600000);
  const minPoolTokens = Number(AIRDROP_MIN_POOL_TOKENS ?? 1);
  const concurrency = Math.max(1, Math.min(20, Number(AIRDROP_CONCURRENCY ?? 6)));

  const treasuryKp = loadKeypairFromEnv(AIRDROP_TREASURY_SECRET_JSON, AIRDROP_TREASURY_SECRET_B58);
  if (!treasuryKp) throw new Error("Missing AIRDROP_TREASURY secret (JSON or B58)");

  const feeWalletPk = new PublicKey(String(FEE_WALLET));

  if (treasuryKp.publicKey.toBase58() !== feeWalletPk.toBase58()) {
    throw new Error(
      `AIRDROP_TREASURY must control the FEE_WALLET.\n` +
      `FEE_WALLET=${feeWalletPk.toBase58()}\n` +
      `AIRDROP_TREASURY_PUBKEY=${treasuryKp.publicKey.toBase58()}`
    );
  }

  const state = readJsonSafe(STATE_PATH, {
    lastFeeBalanceBase: "0",
    lastRunIso: "",
  });

  let running = false;

  async function readFeeWalletTokenBalanceBase({ tokenMintStr, decimals }) {
    const mintPk = new PublicKey(tokenMintStr);

// Fee wallet ATA for Token-2022
    const feeAta = getAssociatedTokenAddressSync(
      mintPk,
      feeWalletPk,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      const bal = await connection.getTokenAccountBalance(feeAta, "confirmed");
      const amt = bal?.value?.amount;
      return amt ? BigInt(String(amt)) : 0n;
    } catch {
// If ATA doesn't exist, treat as 0 (shouldn't happen if fees have been paid before)
      return 0n;
    }
  }

  async function ensureRecipientAta(tokenMintStr, ownerPk) {
    const mintPk = new PublicKey(tokenMintStr);
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      treasuryKp, // payer (fee wallet)
      mintPk,
      ownerPk, // owner
      false,
      "confirmed",
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return ata.address;
  }

  async function sendToRecipient({ tokenMintStr, decimals, recipientWallet, amountBase }) {
    const mintPk = new PublicKey(tokenMintStr);

    const fromAta = await getOrCreateAssociatedTokenAccount(
      connection,
      treasuryKp,
      mintPk,
      treasuryKp.publicKey,
      false,
      "confirmed",
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const toOwner = new PublicKey(recipientWallet);
    const toAta = await ensureRecipientAta(tokenMintStr, toOwner);

    const sig = await transferChecked(
      connection,
      treasuryKp,
      fromAta.address,
      mintPk,
      toAta,
      treasuryKp.publicKey,
      amountBase,
      decimals,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    return sig;
  }

  async function runOnce() {
    if (running) return;
    running = true;

    try {
      const exp = await fetchExport(EXPORT_URL);

      const tokenMintStr = String(exp?.config?.tokenMint || "").trim();
      if (!tokenMintStr || tokenMintStr.includes("YOUR_TOKEN_MINT")) {
        console.error(" AIRDROP: tokenMint unset in export");
        return;
      }

// Use on-chain decimals (authoritative)
      const mintPk = new PublicKey(tokenMintStr);
      const mintInfo = await getMint(connection, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
      const decimals = Number(mintInfo.decimals ?? Number(TOKEN_DECIMALS ?? 9));

// Build recipients from roster; weight = roster
      const roster = Array.isArray(exp?.roster) ? exp.roster : [];
      const byWallet = new Map(); // wallet -> weightBase

      for (const row of roster) {
        const wallet = String(row?.wallet || "").trim();
        if (!wallet) continue;

        const bal = Number(row?.balance ?? 0) || 0;
        if (!(bal > 0)) continue;

        const weightBase = toBaseUnitsFloatTokens(bal, decimals);
        if (weightBase <= 0n) continue;

// dedupe wallets: keep max weight if duplicates
        const prev = byWallet.get(wallet) || 0n;
        if (weightBase > prev) byWallet.set(wallet, weightBase);
      }

      const recipients = Array.from(byWallet.entries()).map(([wallet, weightBase]) => ({ wallet, weightBase }));
      if (recipients.length === 0) {
        console.log("ℹ AIRDROP: no eligible recipients (no positive balances on roster).");
        return;
      }

      const feeBalNow = await readFeeWalletTokenBalanceBase({ tokenMintStr, decimals });
      const feeBalPrev = BigInt(String(state.lastFeeBalanceBase || "0"));

      const delta = feeBalNow - feeBalPrev;
      if (delta <= 0n) {
        state.lastFeeBalanceBase = feeBalNow.toString();
        state.lastRunIso = new Date().toISOString();
        writeJsonSafe(STATE_PATH, state);
        console.log(`ℹ AIRDROP: no new fees. feeBal=${baseToUi(feeBalNow, decimals)} SRPSL`);
        return;
      }

// pool = 2/3 of newly accrued fees
      const pool = (delta * 2n) / 3n;

      const minPoolBase = BigInt(String(Math.floor(minPoolTokens))) * (10n ** BigInt(decimals));
      if (pool < minPoolBase) {
// still advance baseline so we don't accumulate dust and suddenly blast later (your call)
        state.lastFeeBalanceBase = feeBalNow.toString();
        state.lastRunIso = new Date().toISOString();
        writeJsonSafe(STATE_PATH, state);
        console.log(`ℹ AIRDROP: pool too small (${baseToUi(pool, decimals)}). Advanced baseline.`);
        return;
      }

// Pro-rata allocation
      let totalWeight = 0n;
      for (const r of recipients) totalWeight += r.weightBase;
      if (totalWeight <= 0n) {
        console.log("ℹ AIRDROP: totalWeight <= 0, skipping.");
        return;
      }

// initial floor allocations
      const allocs = recipients
        .map((r) => {
          const raw = (pool * r.weightBase) / totalWeight;
          return { wallet: r.wallet, amountBase: raw, weightBase: r.weightBase };
        })
        .filter((x) => x.amountBase > 0n);

      if (allocs.length === 0) {
        state.lastFeeBalanceBase = feeBalNow.toString();
        state.lastRunIso = new Date().toISOString();
        writeJsonSafe(STATE_PATH, state);
        console.log(`ℹ AIRDROP: allocations all zero. Advanced baseline.`);
        return;
      }

// distribute remainder to biggest holders (deterministic)
      let sentBase = 0n;
      for (const a of allocs) sentBase += a.amountBase;
      let remainder = pool - sentBase;

      if (remainder > 0n) {
        allocs.sort((a, b) => (b.weightBase > a.weightBase ? 1 : b.weightBase < a.weightBase ? -1 : 0));
        for (let i = 0; i < allocs.length && remainder > 0n; i++) {
          allocs[i].amountBase += 1n;
          remainder -= 1n;
        }
      }

// Safety: ensure we don't send more than pool
      let totalToSend = 0n;
      for (const a of allocs) totalToSend += a.amountBase;
      if (totalToSend > pool) {
        console.error(" AIRDROP: totalToSend > pool (should not happen). Aborting.");
        return;
      }

      console.log(
        ` AIRDROP RUN: recipients=${allocs.length}/${recipients.length} ` +
        `deltaFees=${baseToUi(delta, decimals)} pool(2/3)=${baseToUi(pool, decimals)}`
      );

// Execute transfers with bounded concurrency
      const results = [];
      const batches = chunked(allocs, concurrency);

      for (const batch of batches) {
        const ps = batch.map(async (a) => {
          try {
            const sig = await sendToRecipient({
              tokenMintStr,
              decimals,
              recipientWallet: a.wallet,
              amountBase: a.amountBase,
            });
            return { wallet: a.wallet, ok: true, sig, amountBase: a.amountBase };
          } catch (e) {
            return { wallet: a.wallet, ok: false, err: String(e?.message || e), amountBase: a.amountBase };
          }
        });

        const done = await Promise.all(ps);
        results.push(...done);
      }

      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;

      let sentOkBase = 0n;
      for (const r of results) if (r.ok) sentOkBase += BigInt(String(r.amountBase));

      console.log(
        ` AIRDROP DONE: ok=${ok} fail=${fail} sent=${baseToUi(sentOkBase, decimals)} ` +
        `(pool=${baseToUi(pool, decimals)})`
      );

// Update baseline to current fee balance so we only airdrop newly accrued fees next run
      state.lastFeeBalanceBase = feeBalNow.toString();
      state.lastRunIso = new Date().toISOString();
      writeJsonSafe(STATE_PATH, state);
    } catch (e) {
      console.error(" AIRDROP ERROR:", e);
    } finally {
      running = false;
    }
  }

// Run once at startup, then hourly
  runOnce().catch(() => {});
  setInterval(() => runOnce().catch(() => {}), everyMs);

  console.log(` Fee airdrop module enabled | everyMs=${everyMs} | pro-rata | pool=2/3 of new fees`);
}
