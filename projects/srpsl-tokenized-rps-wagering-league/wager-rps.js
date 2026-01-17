/*
 * FILE: wager-rps.js
 *
 * Purpose:
 * - Token wager flow for Rock-Paper-Scissors matches.
 *
 * Summary:
 * - Creates a wager session and tracks funding.
 * - Detects deposits for Token-2022 accounts.
 * - Prevents historical deposits from satisfying new wagers.
 * - Starts the match once both sides are funded.
 */

import bs58 from "bs58";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getMint,
  transferChecked,
} from "@solana/spl-token";

import { reserveUsers, releaseUsers } from "./rps-game.js";

const PREFIX = "%rps";

// Memo programs to block (no-memo rule)
const MEMO_PROGRAM_IDS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

function txHasMemoInstruction(parsedTx) {
  try {
    const outer = parsedTx?.transaction?.message?.instructions || [];
    const innerGroups = parsedTx?.meta?.innerInstructions || [];

    const toPidStr = (pid) => {
      if (!pid) return "";
      if (typeof pid === "string") return pid;
      if (pid?.toBase58) return pid.toBase58();
      return String(pid);
    };

    for (const ix of outer) {
      const pid = toPidStr(ix?.programId);
      if (pid && MEMO_PROGRAM_IDS.has(pid)) return true;
      const prog = String(ix?.program || "").toLowerCase();
      if (prog === "memo" || prog === "spl-memo") return true;
    }

    for (const group of innerGroups) {
      for (const ix of group?.instructions || []) {
        const pid = toPidStr(ix?.programId);
        if (pid && MEMO_PROGRAM_IDS.has(pid)) return true;
      }
    }
  } catch {}
  return false;
}

function parseMention(token) {
  const m = String(token || "").match(/^<@!?(\d+)>$/);
  return m ? m[1] : null;
}

function sid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowMs() {
  return Date.now();
}

function toBaseUnitsInt(amountTokens, decimals) {
  const n = BigInt(amountTokens); // integer-only wagers
  const pow = 10n ** BigInt(decimals);
  return n * pow;
}

async function fetchExport(EXPORT_URL) {
  const res = await fetch(String(EXPORT_URL));
  if (!res.ok) throw new Error(`Export fetch failed: ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Export error: ${json.error || "unknown"}`);
  return json;
}

function acceptRow(sessionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wager:${sessionId}:accept`).setLabel("Accept Wager").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wager:${sessionId}:decline`).setLabel("Decline").setStyle(ButtonStyle.Danger)
  );
}

function makePendingEmbed(session) {
  return new EmbedBuilder()
    .setTitle(`Wager Challenge (Table ${session.tableIndex})`)
    .setDescription(
      `Wager: **${session.amountTokens} SRPSL** each\n` +
        `Opponent: <@${session.b.discordId}>\n\n` +
        `Waiting for <@${session.b.discordId}> to **Accept** or **Decline**.`
    );
}

function makeWagerEmbed(session) {
  const aLine = session.funded.a ? ` <@${session.a.discordId}> paid` : ` <@${session.a.discordId}> waiting`;
  const bLine = session.funded.b ? ` <@${session.b.discordId}> paid` : ` <@${session.b.discordId}> waiting`;

  const expiresIn = Math.max(0, (session.expiresAt || 0) - nowMs());
  const sec = Math.floor(expiresIn / 1000);

  const potTokens = session.amountTokens * 2;
  const feeTokens = Math.floor((potTokens * session.feeBps) / 10000);
  const winnerTokens = potTokens - feeTokens;

  return new EmbedBuilder()
    .setTitle(`Wager Funding (Table ${session.tableIndex})`)
    .setDescription(
      `Wager: **${session.amountTokens} SRPSL** each\n` +
        `Pot: **${potTokens} SRPSL**\n` +
        `Fee: **${session.feeBps / 100}%**  Winner receives **${winnerTokens} SRPSL**\n\n` +
        `${aLine}\n${bLine}\n\n` +
        `Send **exactly ${session.amountTokens} SRPSL** to this escrow wallet:\n` +
        `\`${session.escrowWallet}\`\n\n` +
        `Expires in: **${sec}s**\n` +
        `Rules: exact amount • linked wallet only • no-memo tx • 1 active wager per player`
    );
}

async function getSolBalance(connection, pubkey) {
  const lamports = await connection.getBalance(pubkey);
  return lamports / 1e9;
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

/* -------------------- Token-2022 deposit detection helpers -------------------- */

function getStaticAccountKeysBase58(parsedTx) {
  const out = [];
  try {
    const keys = parsedTx?.transaction?.message?.accountKeys || [];
    for (const k of keys) {
      if (typeof k === "string") out.push(k);
      else if (k?.pubkey?.toBase58) out.push(k.pubkey.toBase58());
      else if (k?.toBase58) out.push(k.toBase58());
      else out.push(String(k?.pubkey ?? k));
    }
  } catch {}
  return out;
}

function tokenBalAmountBigInt(entry) {
  try {
    const a = entry?.uiTokenAmount?.amount;
    if (a == null) return 0n;
    return BigInt(String(a));
  } catch {
    return 0n;
  }
}

function getSignerPubkeysBase58(parsedTx) {
  try {
    const msg = parsedTx?.transaction?.message;
    const keys = msg?.accountKeys || [];
    const header = msg?.header;
    const n = Number(header?.numRequiredSignatures ?? 0);

    const signers = [];
    for (let i = 0; i < Math.min(n, keys.length); i++) {
      const k = keys[i];
      if (typeof k === "string") signers.push(k);
      else if (k?.pubkey?.toBase58) signers.push(k.pubkey.toBase58());
      else if (k?.toBase58) signers.push(k.toBase58());
      else signers.push(String(k?.pubkey ?? k));
    }
    return signers;
  } catch {
    return [];
  }
}

/**
 * Detect exact deposit into escrow token account via meta deltas.
 * IMPORTANT: returns payer "a" or "b" ONLY if confident; otherwise payer = null.
 */
function detectExactDepositFromMeta(parsedTx, {
  escrowTokenAccount,
  mint,
  aWallet,
  bWallet,
  expectedAmountBase,
}) {
  if (!parsedTx?.meta || !parsedTx?.transaction) return { ok: false };
  if (parsedTx.meta.err) return { ok: false };

  const mintStr = String(mint);
  const escrowTaStr = String(escrowTokenAccount);

  const staticKeys = getStaticAccountKeysBase58(parsedTx);
  const escrowIndex = staticKeys.indexOf(escrowTaStr);
  if (escrowIndex < 0) return { ok: false };

  const preTB = parsedTx.meta.preTokenBalances || [];
  const postTB = parsedTx.meta.postTokenBalances || [];

  const preEsc = preTB.find((b) => b.mint === mintStr && b.accountIndex === escrowIndex);
  const postEsc = postTB.find((b) => b.mint === mintStr && b.accountIndex === escrowIndex);

  const received = tokenBalAmountBigInt(postEsc) - tokenBalAmountBigInt(preEsc);
  if (received !== expectedAmountBase) return { ok: false };

  const aStr = String(aWallet);
  const bStr = String(bWallet);

  let aMatch = false;
  let bMatch = false;

// Look for a corresponding -expectedAmountBase on an owner token account belonging to payer
  const byIndex = new Map();
  for (const b of preTB) {
    if (b.mint !== mintStr) continue;
    byIndex.set(b.accountIndex, { owner: String(b.owner || ""), pre: tokenBalAmountBigInt(b), post: 0n });
  }
  for (const b of postTB) {
    if (b.mint !== mintStr) continue;
    const prev = byIndex.get(b.accountIndex) || { owner: "", pre: 0n, post: 0n };
    byIndex.set(b.accountIndex, { owner: String(prev.owner || b.owner || ""), pre: prev.pre, post: tokenBalAmountBigInt(b) });
  }

  for (const [idx, row] of byIndex.entries()) {
    if (idx === escrowIndex) continue;
    const delta = row.post - row.pre;
    if (delta !== -expectedAmountBase) continue;
    if (row.owner === aStr) aMatch = true;
    if (row.owner === bStr) bMatch = true;
  }

  if (aMatch && !bMatch) return { ok: true, payer: "a" };
  if (bMatch && !aMatch) return { ok: true, payer: "b" };

// signer fallback ONLY if exactly one signer matches
  const signers = new Set(getSignerPubkeysBase58(parsedTx));
  if (signers.has(aStr) && !signers.has(bStr)) return { ok: true, payer: "a" };
  if (signers.has(bStr) && !signers.has(aStr)) return { ok: true, payer: "b" };

// ambiguous
  return { ok: true, payer: null };
}

async function resolveEscrowToken2022Accounts(connection, tokenMintStr, escrowOwnerPk) {
  const mintPk = new PublicKey(tokenMintStr);

  const ata2022 = getAssociatedTokenAddressSync(
    mintPk,
    escrowOwnerPk,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ).toBase58();

  const out = new Set([ata2022]);

  try {
    const resp = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: mintPk.toBase58() } }, // mint
        { memcmp: { offset: 32, bytes: escrowOwnerPk.toBase58() } }, // owner
      ],
    });

    for (const acc of resp || []) {
      if (acc?.pubkey) out.add(acc.pubkey.toBase58());
    }
  } catch {}

  return Array.from(out);
}

/* -------------------- Module -------------------- */

export function setupWagerRps({
  client,
  EXPORT_URL,
  RPC_URL,

  MIN_SOL_FOR_WAGERS,

  WAGER_CHANNEL_IDS,
  ESCROW_KEYPAIRS,

  FEE_BPS,
  FEE_WALLET,

  WAGER_MIN_TOKENS,
  WAGER_MAX_TOKENS,
  WAGER_FUND_WINDOW_MS,

  startRpsMatch,
  endRpsMatchByUsers,
}) {
  const connection = new Connection(String(RPC_URL), "confirmed");

  const minSol = Number(MIN_SOL_FOR_WAGERS ?? 0.05);
  const minWager = Number(WAGER_MIN_TOKENS ?? 100);
  const maxWager = Number(WAGER_MAX_TOKENS ?? 1_000_000);
  const fundWindowMs = Number(WAGER_FUND_WINDOW_MS ?? 300000);

  const feeBps = Number(FEE_BPS ?? 100);
  const feeWallet = String(FEE_WALLET || "").trim();
  if (!feeWallet) throw new Error("Missing FEE_WALLET");
  const feeWalletPk = new PublicKey(feeWallet);

  const sessions = new Map();
  const sessionByUser = new Map();

  if (!Array.isArray(WAGER_CHANNEL_IDS) || WAGER_CHANNEL_IDS.length !== 5) {
    throw new Error("WAGER_CHANNEL_IDS must be an array of length 5");
  }
  if (!Array.isArray(ESCROW_KEYPAIRS) || ESCROW_KEYPAIRS.length !== 5) {
    throw new Error("ESCROW_KEYPAIRS must be an array of length 5");
  }

  function channelToTableIndex(channelId) {
    return WAGER_CHANNEL_IDS.indexOf(channelId);
  }

  async function buildRosterMap() {
    const exp = await fetchExport(EXPORT_URL);
    const tokenMint = String(exp?.config?.tokenMint || "").trim();
    const roster = exp?.roster || [];

    const map = new Map();
    for (const row of roster) {
      const did = String(row.discordId || "").trim();
      const wallet = String(row.wallet || "").trim();
      if (did && wallet) map.set(did, wallet);
    }
    return { tokenMint, rosterMap: map };
  }

  async function getOrCreateEscrowAta2022(tokenMint, escrowKeypair) {
    const mintPk = new PublicKey(tokenMint);

    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      escrowKeypair,
      mintPk,
      escrowKeypair.publicKey,
      false,
      "confirmed",
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    return ata.address.toBase58();
  }

  async function payToken2022({ tokenMint, decimals, fromKeypair, toOwnerPubkey, amountBase }) {
    const mintPk = new PublicKey(tokenMint);

    const fromAta = await getOrCreateAssociatedTokenAccount(
      connection,
      fromKeypair,
      mintPk,
      fromKeypair.publicKey,
      false,
      "confirmed",
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const toAta = await getOrCreateAssociatedTokenAccount(
      connection,
      fromKeypair,
      mintPk,
      toOwnerPubkey,
      false,
      "confirmed",
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const sig = await transferChecked(
      connection,
      fromKeypair,
      fromAta.address,
      mintPk,
      toAta.address,
      fromKeypair.publicKey,
      amountBase,
      decimals,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    return sig;
  }

  async function refundOne(session, which) {
    const s = session;
    const payer = which === "a" ? s.a : s.b;

    await payToken2022({
      tokenMint: s.tokenMint,
      decimals: s.decimals,
      fromKeypair: s.escrowKeypair,
      toOwnerPubkey: new PublicKey(payer.wallet),
      amountBase: s.amountBaseUnits,
    });
  }

  async function refundBoth(session) {
    await refundOne(session, "a").catch(() => {});
    await refundOne(session, "b").catch(() => {});
  }

  async function endSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;

    sessionByUser.delete(s.a.discordId);
    sessionByUser.delete(s.b.discordId);

    releaseUsers(s.a.discordId, s.b.discordId);

    try { if (s.pollTimer) clearInterval(s.pollTimer); } catch {}
    try { if (s.expireTimer) clearTimeout(s.expireTimer); } catch {}
    try { if (s.acceptTimer) clearTimeout(s.acceptTimer); } catch {}

    sessions.delete(sessionId);
  }

  async function handleExpire(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;

    const prevStatus = s.status;
    if (prevStatus !== "funding" && prevStatus !== "pending_accept") return;

    s.status = "expired";

    if (prevStatus === "pending_accept") {
      await s.message.edit({ content: ` Wager invite expired (no response).`, embeds: [], components: [] }).catch(() => {});
      await endSession(sessionId);
      return;
    }

    const aPaid = s.funded.a;
    const bPaid = s.funded.b;

    if (aPaid && !bPaid) {
      await refundOne(s, "a").catch(() => {});
      await s.message.edit({ content: ` Funding expired. Refunded <@${s.a.discordId}>.`, embeds: [], components: [] }).catch(() => {});
      await endSession(sessionId);
      return;
    }

    if (!aPaid && bPaid) {
      await refundOne(s, "b").catch(() => {});
      await s.message.edit({ content: ` Funding expired. Refunded <@${s.b.discordId}>.`, embeds: [], components: [] }).catch(() => {});
      await endSession(sessionId);
      return;
    }

    if (aPaid && bPaid) {
      await refundBoth(s).catch(() => {});
      await s.message.edit({ content: ` Funding expired. Both refunded.`, embeds: [], components: [] }).catch(() => {});
      await endSession(sessionId);
      return;
    }

    await s.message.edit({ content: ` Funding expired. No one paid.`, embeds: [], components: [] }).catch(() => {});
    await endSession(sessionId);
  }

  function isAdminMember(message) {
    return Boolean(message.member?.permissions?.has("Administrator"));
  }

  async function adminEndWagerByUsers(message, userIdA, userIdB) {
    let sess = null;
    for (const s of sessions.values()) {
      const ids = [s.a.discordId, s.b.discordId];
      if (ids.includes(userIdA) && ids.includes(userIdB) && userIdA !== userIdB) {
        sess = s;
        break;
      }
    }
    if (!sess) {
      await message.reply("No active wager found for those two players.").catch(() => {});
      return;
    }

    sess.adminEnded = true;

    if (sess.status === "active_match") {
      try {
        await endRpsMatchByUsers(message.channel, userIdA, userIdB, { silent: true, endedByAdmin: true });
      } catch {}

      await refundBoth(sess).catch(() => {});
      await message.channel.send(` **Wager ended by admin.** Refunded both players.`).catch(() => {});
      await endSession(sess.id);
      return;
    }

    if (sess.funded.a && !sess.funded.b) await refundOne(sess, "a").catch(() => {});
    if (!sess.funded.a && sess.funded.b) await refundOne(sess, "b").catch(() => {});
    if (sess.funded.a && sess.funded.b) await refundBoth(sess).catch(() => {});

    await message.channel.send(` **Wager ended by admin.** Refunded any paid funds.`).catch(() => {});
    try { await sess.message.edit({ content: ` Wager ended by admin.`, embeds: [], components: [] }).catch(() => {}); } catch {}
    await endSession(sess.id);
  }

  async function pollDeposits(sessionId) {
    const s = sessions.get(sessionId);
    if (!s || s.status !== "funding") return;
    if (nowMs() > s.expiresAt) return;

    for (const ta of s.escrowTokenAccounts) {
      let sigs = [];
      try {
        sigs = await connection.getSignaturesForAddress(new PublicKey(ta), { limit: 25 }, "confirmed");
      } catch {
        continue;
      }

      for (const item of sigs) {
        const signature = item?.signature;
        const slot = Number(item?.slot ?? 0);

        if (!signature) continue;

// CRITICAL: ignore anything before this wager's funding start slot
        if (Number.isFinite(s.startSlot) && s.startSlot > 0 && slot > 0 && slot < s.startSlot) continue;

        if (s.seenSigs.has(signature)) continue;
        s.seenSigs.add(signature);

        let tx = null;
        try {
          tx = await connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
        } catch {
          continue;
        }
        if (!tx) continue;
        if (txHasMemoInstruction(tx)) continue;

        const dep = detectExactDepositFromMeta(tx, {
          escrowTokenAccount: ta,
          mint: s.tokenMint,
          aWallet: s.a.wallet,
          bWallet: s.b.wallet,
          expectedAmountBase: s.amountBaseUnits,
        });

        if (!dep.ok) continue;

// CRITICAL: require attribution to A or B (no ambiguous credits)
        if (dep.payer !== "a" && dep.payer !== "b") continue;

        if (dep.payer === "a") s.funded.a = true;
        if (dep.payer === "b") s.funded.b = true;

        await s.message.edit({ embeds: [makeWagerEmbed(s)] }).catch(() => {});

        if (s.funded.a && s.funded.b && s.status === "funding") {
          s.status = "active_match";

          await s.message.edit({
            embeds: [new EmbedBuilder().setTitle("Wager Funded ").setDescription(`Both players paid. Match starting now.`)],
            components: [],
          }).catch(() => {});

          const guild = await client.guilds.fetch(s.guildId);
          const channel = await guild.channels.fetch(s.channelId);

          const potBase = s.amountBaseUnits * 2n;
          const feeBase = (potBase * BigInt(s.feeBps)) / 10000n;
          const winnerBase = potBase - feeBase;

// deadlock fix: release wager busy-reservation so startRpsMatch can proceed
          releaseUsers(s.a.discordId, s.b.discordId);

          let gameId = null;
          try {
            gameId = await startRpsMatch(channel, guild, s.a.discordId, s.b.discordId, {
              allowAnyChannel: true,
              onMatchEnd: async ({ winnerId, endedByAdmin }) => {
                if (endedByAdmin) {
                  await endSession(s.id);
                  return;
                }

                if (!winnerId) {
                  await channel.send(" Tie game — both wagers refunded.").catch(() => {});
                  await refundBoth(s).catch(() => {});
                  await endSession(s.id);
                  return;
                }

                const winnerWallet = s.rosterMap.get(String(winnerId));
                if (!winnerWallet) {
                  await channel.send(" Winner wallet not found on roster — refunded both.").catch(() => {});
                  await refundBoth(s).catch(() => {});
                  await endSession(s.id);
                  return;
                }

                await payToken2022({
                  tokenMint: s.tokenMint,
                  decimals: s.decimals,
                  fromKeypair: s.escrowKeypair,
                  toOwnerPubkey: new PublicKey(winnerWallet),
                  amountBase: winnerBase,
                }).catch(async () => {
                  await channel.send(" Payout failed — refunded both.").catch(() => {});
                  await refundBoth(s).catch(() => {});
                  await endSession(s.id);
                });

                if (feeBase > 0n) {
                  await payToken2022({
                    tokenMint: s.tokenMint,
                    decimals: s.decimals,
                    fromKeypair: s.escrowKeypair,
                    toOwnerPubkey: feeWalletPk,
                    amountBase: feeBase,
                  }).catch(() => {});
                }

                await channel.send(` Wager paid out to <@${winnerId}>. Fee: **${s.feeBps / 100}%**`).catch(() => {});
                await endSession(s.id);
              },
            });
          } catch (e) {
// If match start fails, re-reserve so wager session stays consistent
            reserveUsers(`wager:${s.id}`, s.a.discordId, s.b.discordId);
            s.status = "funding";
            console.error(" startRpsMatch failed:", e);
            await channel.send(" Failed to start match. Check bot logs.").catch(() => {});
            return;
          }

          s.gameId = gameId;
          return;
        }
      }
    }
  }

// Buttons: accept/decline wager
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isButton()) return;
      const cid = String(interaction.customId || "");
      if (!cid.startsWith("wager:")) return;

      const parts = cid.split(":");
      const sessionId = parts[1];
      const action = parts[2];

      const s = sessions.get(sessionId);
      if (!s) {
        await interaction.reply({ content: "This wager no longer exists.", ephemeral: true }).catch(() => {});
        return;
      }

      if (interaction.user.id !== s.b.discordId) {
        await interaction.reply({ content: "Only the invited player can Accept/Decline.", ephemeral: true }).catch(() => {});
        return;
      }

      await interaction.deferUpdate().catch(() => {});
      if (s.status !== "pending_accept") return;

      if (action === "decline") {
        s.status = "declined";
        await s.message.edit({ content: ` Wager declined by <@${s.b.discordId}>.`, embeds: [], components: [] }).catch(() => {});
        await endSession(sessionId);
        return;
      }

      if (action === "accept") {
        s.status = "funding";
        s.expiresAt = nowMs() + s.fundWindowMs;

// CRITICAL: set baseline slot so we ignore ALL old deposits
        try {
          s.startSlot = await connection.getSlot("confirmed");
        } catch {
          s.startSlot = 0; // if RPC fails, we still function
        }

        await s.message.edit({ content: "", embeds: [makeWagerEmbed(s)], components: [] }).catch(() => {});

        s.expireTimer = setTimeout(() => { handleExpire(sessionId).catch(() => {}); }, s.fundWindowMs + 1000);
        s.pollTimer = setInterval(() => { pollDeposits(sessionId).catch(() => {}); }, 3000);
        return;
      }
    } catch (e) {
      console.error(" wager button error:", e);
    }
  });

// Message commands: wager + admin end
  client.on("messageCreate", async (message) => {
    try {
      if (!message?.content) return;
      if (message.author.bot) return;

      const content = message.content.trim();
      if (!content.toLowerCase().startsWith(PREFIX)) return;

      const tokens = content.split(/\s+/);
      const sub = String(tokens[1] || "").toLowerCase();

      if (sub === "end") {
        if (!isAdminMember(message)) {
          await message.reply(" You must be an Administrator to use this command.").catch(() => {});
          return;
        }
        const aId = tokens[2] ? parseMention(tokens[2]) : null;
        const bId = tokens[3] ? parseMention(tokens[3]) : null;
        if (!aId || !bId) {
          await message.reply(`Usage: \`${PREFIX} end @player1 @player2\``).catch(() => {});
          return;
        }
        await adminEndWagerByUsers(message, aId, bId);
        return;
      }

      if (sub !== "wager") return;

      const tableIndex = channelToTableIndex(message.channel.id);
      if (tableIndex < 0) {
        await message.reply(" Wagers are only allowed in the wager channels.").catch(() => {});
        return;
      }

      const amtStr = tokens[2];
      const mentionTok = tokens[3];

      const amountTokens = Number(amtStr);
      if (!Number.isFinite(amountTokens) || amountTokens <= 0 || !Number.isInteger(amountTokens)) {
        await message.reply(` Usage: \`${PREFIX} wager 1000 @user\` (amount must be whole tokens)`).catch(() => {});
        return;
      }
      if (amountTokens < minWager || amountTokens > maxWager) {
        await message.reply(` Wager must be between ${minWager} and ${maxWager} tokens.`).catch(() => {});
        return;
      }

      const otherId = parseMention(mentionTok);
      if (!otherId) {
        await message.reply(` Usage: \`${PREFIX} wager 1000 @user\``).catch(() => {});
        return;
      }
      if (otherId === message.author.id) {
        await message.reply(" You can't wager yourself.").catch(() => {});
        return;
      }

      if (sessionByUser.has(message.author.id) || sessionByUser.has(otherId)) {
        await message.reply(" One of the players is already in an active wager.").catch(() => {});
        return;
      }

      const { tokenMint, rosterMap } = await buildRosterMap();
      if (!tokenMint || tokenMint.includes("YOUR_TOKEN_MINT")) {
        await message.reply(" Token mint not set yet in Apps Script export.").catch(() => {});
        return;
      }

      const aWallet = rosterMap.get(message.author.id);
      const bWallet = rosterMap.get(otherId);
      if (!aWallet) { await message.reply(" Your wallet isn’t on the roster yet.").catch(() => {}); return; }
      if (!bWallet) { await message.reply(" That user’s wallet isn’t on the roster yet.").catch(() => {}); return; }

      const escrowKeypair = ESCROW_KEYPAIRS[tableIndex];
      const sol = await getSolBalance(connection, escrowKeypair.publicKey);
      if (sol < minSol) {
        await message.reply(` This table is paused (escrow low on SOL for fees).`).catch(() => {});
        return;
      }

      const mintPk = new PublicKey(tokenMint);
      const mintInfo = await getMint(connection, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
      const decimals = Number(mintInfo.decimals);

      const escrowWallet = escrowKeypair.publicKey.toBase58();

      const escrowTokenAccount = await getOrCreateEscrowAta2022(tokenMint, escrowKeypair);
      const escrowTokenAccounts = await resolveEscrowToken2022Accounts(connection, tokenMint, escrowKeypair.publicKey);

      const sessionId = sid();
      reserveUsers(`wager:${sessionId}`, message.author.id, otherId);

      const session = {
        id: sessionId,
        status: "pending_accept",

        guildId: message.guild.id,
        channelId: message.channel.id,

        tableIndex: tableIndex + 1,

        tokenMint,
        decimals,
        feeBps,

        amountTokens,
        amountBaseUnits: toBaseUnitsInt(amountTokens, decimals),

        a: { discordId: message.author.id, wallet: aWallet },
        b: { discordId: otherId, wallet: bWallet },

        funded: { a: false, b: false },

        escrowKeypair,
        escrowWallet,

        escrowTokenAccount,
        escrowTokenAccounts,

        createdAt: nowMs(),
        expiresAt: null,

        fundWindowMs,

// baseline slot set on accept
        startSlot: 0,

        seenSigs: new Set(),
        pollTimer: null,
        expireTimer: null,
        acceptTimer: null,

        message: null,

        rosterMap,
        gameId: null,
        adminEnded: false,
      };

      sessions.set(sessionId, session);
      sessionByUser.set(session.a.discordId, sessionId);
      sessionByUser.set(session.b.discordId, sessionId);

      session.message = await message.channel.send({
        embeds: [makePendingEmbed(session)],
        components: [acceptRow(sessionId)],
      });

      session.acceptTimer = setTimeout(async () => {
        const s = sessions.get(sessionId);
        if (!s || s.status !== "pending_accept") return;
        await s.message.edit({ content: ` Wager invite expired (no response).`, embeds: [], components: [] }).catch(() => {});
        await endSession(sessionId);
      }, 2 * 60 * 1000);
    } catch (e) {
      console.error(" wager error:", e);
      await message.reply(" Wager error. Check logs.").catch(() => {});
    }
  });

  console.log(" Wager module loaded | Use: %rps wager <amount> @user (wager channels only)");
}

export function loadFiveEscrowsFromEnv(env) {
  const keys = [];
  for (let i = 1; i <= 5; i++) {
    const kp = loadKeypairFromEnv(env[`ESCROW_${i}_SECRET_JSON`], env[`ESCROW_${i}_SECRET_B58`]);
    if (!kp) throw new Error(`Missing escrow key for ESCROW_${i}`);
    keys.push(kp);
  }
  return keys;
}
