/*
 * FILE: index.js
 *
 * Purpose:
 * - Discord bot entry point.
 *
 * Summary:
 * - Loads configuration from environment variables.
 * - Starts eligibility sync and wager mode modules.
 * - Posts updates back to the roster source.
 */

import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { setupRpsGame, startRpsMatch, endRpsMatchByUsers } from "./rps-game.js";
import { setupWagerRps, loadFiveEscrowsFromEnv } from "./wager-rps.js";
import { setupFeeAirdrop } from "./airdrop-fees.js";

// Streamflow SDK + BN helper
import BN from "bn.js";
import { SolanaStreamClient, ICluster, getNumberFromBN } from "@streamflow/stream";

/* -------------------- ENV -------------------- */
const {
  DISCORD_TOKEN,
  GUILD_ID,
  ROLE_PLAYER_ID,
  ROLE_ELITE_ID,
  ROLE_MANAGER_ID,
  EXPORT_URL,
  RPC_URL,

  FORM_RELEASE_ISO,
  SEASON_LENGTH_DAYS,
  TOKEN_DECIMALS,
  CHECK_EVERY_MS,

  POST_SHARED_SECRET,
} = process.env;

function requireEnv(name, value) {
  if (!value || String(value).trim() === "") {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

// REQUIRED env vars
requireEnv("DISCORD_TOKEN", DISCORD_TOKEN);
requireEnv("GUILD_ID", GUILD_ID);
requireEnv("ROLE_PLAYER_ID", ROLE_PLAYER_ID);
requireEnv("ROLE_ELITE_ID", ROLE_ELITE_ID);
requireEnv("ROLE_MANAGER_ID", ROLE_MANAGER_ID);
requireEnv("EXPORT_URL", EXPORT_URL);
requireEnv("RPC_URL", RPC_URL);
requireEnv("FORM_RELEASE_ISO", FORM_RELEASE_ISO);
requireEnv("POST_SHARED_SECRET", POST_SHARED_SECRET);

const tokenDecimals = Number(TOKEN_DECIMALS ?? 9);
const intervalMs = Number(CHECK_EVERY_MS ?? 300000);
const seasonLengthDays = Number(SEASON_LENGTH_DAYS ?? 15);

/* -------------------- SEASON TIME -------------------- */
const formReleaseMs = Date.parse(String(FORM_RELEASE_ISO));
if (!Number.isFinite(formReleaseMs)) {
  console.error(" Bad FORM_RELEASE_ISO. Example: 2026-01-01T18:00:00Z");
  process.exit(1);
}
const seasonEndMs = formReleaseMs + seasonLengthDays * 24 * 60 * 60 * 1000;
const seasonEndSec = Math.floor(seasonEndMs / 1000);

/* -------------------- DISCORD CLIENT -------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

setupRpsGame(client);

/* -------------------- STREAMFLOW CLIENT -------------------- */
const streamClient = new SolanaStreamClient({
  clusterUrl: String(RPC_URL),
  cluster: ICluster.Mainnet,
});

/* -------------------- HELPERS -------------------- */
function normalizeStreamflowId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const parts = s.split("/").filter(Boolean);
  return (parts[parts.length - 1] || "").trim();
}

function round6(n) {
  const x = Number(n || 0) || 0;
  return Math.floor(x * 1_000_000) / 1_000_000;
}

async function fetchExport() {
  const res = await fetch(String(EXPORT_URL));
  if (!res.ok) throw new Error(`Export fetch failed: ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Export error: ${json.error || "unknown"}`);
  return json;
}

async function postSheetUpdates(updates) {
  if (!Array.isArray(updates) || updates.length === 0) return;

  const res = await fetch(String(EXPORT_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: String(POST_SHARED_SECRET),
      updates,
    }),
  });

  if (!res.ok) {
    console.error(" Sheet POST failed:", res.status, await res.text());
    return;
  }

  let json;
  try {
    json = await res.json();
  } catch {
    console.error(" Sheet POST returned non-JSON:", await res.text());
    return;
  }

  if (!json.ok) console.error(" Sheet POST error:", json);
}

async function ensureRole(member, roleId, shouldHave) {
  const has = member.roles.cache.has(roleId);
  if (shouldHave && !has) await member.roles.add(roleId, "SRPSL eligibility sync");
  if (!shouldHave && has) await member.roles.remove(roleId, "SRPSL eligibility sync");
}

async function getValidLockedAmountTokens(streamIdOrUrl, wallet, tokenMint) {
  const id = normalizeStreamflowId(streamIdOrUrl);
  if (!id) return 0;

  let stream;
  try {
    stream = await streamClient.getOne({ id });
  } catch {
    return 0;
  }

  const mint = String(stream?.mint || stream?.tokenId || "");
  const recipient = String(stream?.recipient || "");
  const cancelableBySender = Boolean(stream?.cancelableBySender ?? stream?.canCancel ?? false);

  if (mint !== String(tokenMint)) return 0;
  if (recipient !== String(wallet)) return 0;
  if (cancelableBySender) return 0;

  const cliff = Number(stream?.cliff || 0);
  const start = Number(stream?.start || 0);
  const end = Number(stream?.end || stream?.endTime || 0);
  const unlockSec = Math.max(cliff || 0, start || 0, end || 0);

  if (!Number.isFinite(unlockSec) || unlockSec <= 0) return 0;
  if (unlockSec < seasonEndSec) return 0;

  const raw =
    stream?.depositedAmount ??
    stream?.amount ??
    stream?.deposit ??
    stream?.totalAmount ??
    stream?.totalAmountDeposited ??
    null;

  if (raw == null) return 0;

  let bn;
  try {
    if (BN.isBN(raw)) bn = raw;
    else if (typeof raw === "string") bn = new BN(raw);
    else if (typeof raw === "number") bn = new BN(String(raw));
    else if (raw?.toString) bn = new BN(raw.toString());
    else return 0;
  } catch {
    return 0;
  }

  const amountTokens = getNumberFromBN(bn, tokenDecimals);
  if (!Number.isFinite(amountTokens) || amountTokens <= 0) return 0;

  return amountTokens;
}

async function computeLockedSumTokens(wallet, streamIdsOrUrls, tokenMint) {
  if (!Array.isArray(streamIdsOrUrls) || streamIdsOrUrls.length === 0) return 0;

  let sum = 0;
  for (const sid of streamIdsOrUrls) {
    try {
      const amt = await getValidLockedAmountTokens(sid, wallet, tokenMint);
      sum += amt;
    } catch {}
  }
  return sum;
}

/* -------------------- MAIN SYNC -------------------- */
async function syncOnce() {
  const exp = await fetchExport();

  const tokenMint = exp?.config?.tokenMint;
  if (!tokenMint || String(tokenMint).includes("YOUR_TOKEN_MINT")) {
    console.error(" tokenMint in export looks unset.  Set TOKEN_MINT in Apps Script CONFIG.");
    return;
  }

  const locksMap = exp.locks || {};
  const roster = exp.roster || [];

  const guild = await client.guilds.fetch(String(GUILD_ID));
  await guild.members.fetch();

  const updates = [];

  for (const row of roster) {
    const discordId = String(row.discordId || "").trim();
    const wallet = String(row.wallet || "").trim();
    if (!discordId || !wallet) continue;

    let member;
    try {
      member = await guild.members.fetch(discordId);
    } catch {
      continue;
    }

    const playerOk = !!row.playerOk;
    const eliteOk = !!row.eliteOk;

    const holdTokens = Number(row.balance ?? row.hold ?? row.tokenBalance ?? 0) || 0;

    const streamIds = (locksMap[wallet] || []).map(normalizeStreamflowId);
    const lockedSum = await computeLockedSumTokens(wallet, streamIds, tokenMint);

    const combined = holdTokens + lockedSum;
    const managerOk = combined >= 1_000_000;

    await ensureRole(member, String(ROLE_PLAYER_ID), playerOk);
    await ensureRole(member, String(ROLE_ELITE_ID), eliteOk);
    await ensureRole(member, String(ROLE_MANAGER_ID), managerOk);

    updates.push({
      wallet,
      locked: round6(lockedSum),
      total: round6(combined),
      managerTotalOk: managerOk,
    });
  }

  await postSheetUpdates(updates);

  console.log(` Synced ${roster.length} roster rows @ ${new Date().toISOString()}`);
  console.log(` Season ends @ ${new Date(seasonEndMs).toISOString()} | endSec=${seasonEndSec}`);
  console.log(` Posted ${updates.length} sheet updates`);
}

/* -------------------- STARTUP -------------------- */
client.once("ready", async () => {
  console.log(` Logged in as ${client.user.tag}`);

  try {
    await syncOnce();
  } catch (e) {
    console.error(" Initial sync error:", e);
  }

  setInterval(() => {
    syncOnce().catch((e) => console.error(" sync error:", e));
  }, intervalMs);

// Wager module (optional)
  if (String(process.env.WAGER_ENABLED || "false").toLowerCase() === "true") {
    const WAGER_CHANNEL_IDS = [
      process.env.WAGER_CHANNEL_1_ID,
      process.env.WAGER_CHANNEL_2_ID,
      process.env.WAGER_CHANNEL_3_ID,
      process.env.WAGER_CHANNEL_4_ID,
      process.env.WAGER_CHANNEL_5_ID,
    ].map((x) => String(x || "").trim());

    const ESCROW_KEYPAIRS = loadFiveEscrowsFromEnv(process.env);

    setupWagerRps({
      client,
      EXPORT_URL: process.env.EXPORT_URL,
      RPC_URL: process.env.RPC_URL,
      TOKEN_DECIMALS: process.env.TOKEN_DECIMALS,
      MIN_SOL_FOR_WAGERS: process.env.MIN_SOL_FOR_WAGERS,

      WAGER_CHANNEL_IDS,
      ESCROW_KEYPAIRS,

      FEE_BPS: process.env.FEE_BPS,
      FEE_WALLET: process.env.FEE_WALLET,

      WAGER_MIN_TOKENS: process.env.WAGER_MIN_TOKENS,
      WAGER_MAX_TOKENS: process.env.WAGER_MAX_TOKENS,
      WAGER_FUND_WINDOW_MS: process.env.WAGER_FUND_WINDOW_MS,

      startRpsMatch,
      endRpsMatchByUsers,
    });
  }

// Hourly fee airdrop module (optional)
  if (String(process.env.AIRDROP_ENABLED || "false").toLowerCase() === "true") {
    setupFeeAirdrop({
      EXPORT_URL: process.env.EXPORT_URL,
      RPC_URL: process.env.RPC_URL,
      FEE_WALLET: process.env.FEE_WALLET,
      TOKEN_DECIMALS: process.env.TOKEN_DECIMALS,
      AIRDROP_EVERY_MS: process.env.AIRDROP_EVERY_MS,
      AIRDROP_TREASURY_SECRET_JSON: process.env.AIRDROP_TREASURY_SECRET_JSON,
      AIRDROP_TREASURY_SECRET_B58: process.env.AIRDROP_TREASURY_SECRET_B58,
      AIRDROP_MIN_POOL_TOKENS: process.env.AIRDROP_MIN_POOL_TOKENS,
      AIRDROP_CONCURRENCY: process.env.AIRDROP_CONCURRENCY,
    });
  }
});

process.on("unhandledRejection", (err) => console.error(" unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error(" uncaughtException:", err));

client.login(String(DISCORD_TOKEN));
