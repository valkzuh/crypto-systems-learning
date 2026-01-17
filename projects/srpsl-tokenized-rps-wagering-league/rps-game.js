

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";


const PREFIX = "%rps";
const FIRST_TO = 4;
const CHALLENGE_TIMEOUT_MS = 2 * 60 * 1000;
const MOVE_TIMEOUT_MS = 2 * 60 * 1000;

const EMOJI = {
  rock: "",
  paper: "",
  scissors: "✂️",
  defaultBadge: "⚫",
  win: "",
};


const activeGames = new Map(); // Map<gameId, game>


const activeByUser = new Map(); // Map<userId, busyKey>


const WAGER_RPS_CHANNEL_IDS = new Set([
  "1456923210317824174",
  "1456923229099786462",
  "1456923245465833666",
  "1456923263900061716",
  "1456923289661214837",
]);

// Channels where NORMAL RPS is allowed
const ALLOWED_RPS_CHANNEL_IDS = new Set([
  "1456575873753808958",
  "1456576527104868373",
  "1456576640472715468",
  "1456589537513050162",
  "1456589764001140828",
  "1456589777741811865",
  "1456589790949413006",
  "1456589803624599573",
  "1456589815792537784",
  "1456589837972017184",
  "1456589871975235769",
  "1456589893416390757",
  "1456589908457291875",
  "1456582540638031986",
  "1456582595188883487",
  "1456582624582701137",
  "1456582662369050694",
  "1456582704815673365",
  "1456582763594383472",
  "1456582814077161472",
  "1456581682831294566",
  "1456584265897738240",
  "1456584382243672114",
  "1456584407254175804",
  "1456584468885278845",
  "1456584490280550564",
  "1456584514401861714",
  "1456584538649002003",
  "1456584415013503037",
  "1456585667407511675",
  "1456585711091191879",
  "1456585745681743873",
  "1456585765097046107",
  "1456585794423885889",
  "1456585819962998925",
  "1456585840099594454",
  "1456585831199539200",
  "1456585903995883652",
  "1456585932114366580",
  "1456585945473089740",
  "1456585958228103378",
  "1456585969900720158",
  "1456585992160022672",
  "1456586015476154379",
  "1456586263053336580",
  "1456586044546744330",
  "1456586065954738240",
  "1456586077467840734",
  "1456586104500256911",
  "1456586146543829105",
  "1456586162255823002",
  "1456586187883151392",
  "1456586575185182741",
  "1456586215288475679",
  "1456586247542669362",
  "1456586260209471551",
  "1456586273715261491",
  "1456586285941788722",
  "1456586300999340175",
  "1456586314282700905",
  "1456586827799461949",
  "1456586334679601258",
  "1456586357291090102",
  "1456586369408434227",
  "1456586383048052786",
  "1456586395832553565",
  "1456586410176811129",
  "1456586427482636359",
  "1456587455544164417",
  "1456586460567175295",
  "1456586490271498324",
  "1456586513143038002",
  "1456586529567936512",
  "1456586542897168424",
  "1456586557954855125",
  "1456586572605427840",
  "1456587372287492330",
  "1456586592885145610",
  "1456586613911195815",
  "1456586627290763447",
  "1456586648983830673",
  "1456586661680119943",
  "1456586675227721728",
  "1456586688347504670",
  "1456587288040706140",
  "1456586714947522580",
  "1456586735105474636",
  "1456586747965214770",
  "1456586761525395456",
  "1456586774779527314",
  "1456586788008366202",
  "1456586805645414537",
  "1456587025150115993",
]);


const seenInteractionIds = new Set();
setInterval(() => seenInteractionIds.clear(), 2 * 60 * 1000);

function gid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isMentionedUser(token) {
  return /^<@!?(\d+)>$/.test(token);
}
function parseMention(token) {
  const m = token.match(/^<@!?(\d+)>$/);
  return m ? m[1] : null;
}

function moveEmoji(move) {
  return EMOJI[move] || move;
}
function prettyMove(move) {
  if (move === "rock") return "Rock";
  if (move === "paper") return "Paper";
  if (move === "scissors") return "Scissors";
  return move;
}

function decide(p1Move, p2Move) {
  if (p1Move === p2Move) return 0;
  if (
    (p1Move === "rock" && p2Move === "scissors") ||
    (p1Move === "paper" && p2Move === "rock") ||
    (p1Move === "scissors" && p2Move === "paper")
  ) return 1;
  return 2;
}


export function isUserBusy(userId) {
  return activeByUser.has(userId);
}
export function getUserBusyKey(userId) {
  return activeByUser.get(userId) || null;
}
export function reserveUsers(busyKey, ...userIds) {
  for (const uid of userIds) activeByUser.set(uid, busyKey);
}
export function releaseUsers(...userIds) {
  for (const uid of userIds) activeByUser.delete(uid);
}


function ensureNotInGame(userId) {
  return !activeByUser.has(userId);
}
function markInGame(gameId, p1Id, p2Id) {
  reserveUsers(gameId, p1Id, p2Id);
}
function clearInGame(p1Id, p2Id) {
  releaseUsers(p1Id, p2Id);
}

function normalizeKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getMemberBadgeEmoji(guild, member) {
  try {
    const emojis = guild.emojis.cache;

    const roles = member.roles.cache
      .filter((r) => r && r.name && r.name !== "@everyone")
      .sort((a, b) => b.position - a.position);

    for (const role of roles.values()) {
      const roleKey = normalizeKey(role.name);
      if (!roleKey) continue;

      const match = emojis.find((e) => normalizeKey(e.name) === roleKey);
      if (match) return `<${match.animated ? "a" : ""}:${match.name}:${match.id}>`;
    }
  } catch {}
  return EMOJI.defaultBadge;
}

function tagWithBadge(game, which) {
  const p = which === "p1" ? game.p1 : game.p2;
  return `${p.badge} ${p.tag}`;
}

function gameHeaderText(game) {
  return `**${tagWithBadge(game, "p1")} vs ${tagWithBadge(game, "p2")}**`;
}

function scoreLine(game) {
  return `${tagWithBadge(game, "p1")}: **${game.score.p1}**\n${tagWithBadge(game, "p2")}: **${game.score.p2}**`;
}

function waitingLine(game) {
  const p1Lock = game.current.p1Move ? "✅" : "⌛";
  const p2Lock = game.current.p2Move ? "✅" : "⌛";
  return `${p1Lock} ${tagWithBadge(game, "p1")} locked\n${p2Lock} ${tagWithBadge(game, "p2")} locked`;
}


function challengeRow(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:accept`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:decline`)
      .setLabel("Decline")
      .setStyle(ButtonStyle.Danger)
  );
}

function moveRow(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:move:rock`)
      .setLabel("Rock")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI.rock),
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:move:paper`)
      .setLabel("Paper")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI.paper),
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:move:scissors`)
      .setLabel("Scissors")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI.scissors)
  );
}

function disabledMoveRow(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:move:rock`)
      .setLabel("Rock")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI.rock)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:move:paper`)
      .setLabel("Paper")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI.paper)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:move:scissors`)
      .setLabel("Scissors")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI.scissors)
      .setDisabled(true)
  );
}


function recapEmbed(game) {
  const recapLines = game.rounds.map((r) => {
    const score = `(${r.scoreAfter.p1}-${r.scoreAfter.p2})`;
    return `${moveEmoji(r.p1Move)} vs ${moveEmoji(r.p2Move)}  ${score}`;
  });

  const p1Counts = { rock: 0, paper: 0, scissors: 0 };
  const p2Counts = { rock: 0, paper: 0, scissors: 0 };

  for (const r of game.rounds) {
    p1Counts[r.p1Move] = (p1Counts[r.p1Move] || 0) + 1;
    p2Counts[r.p2Move] = (p2Counts[r.p2Move] || 0) + 1;
  }

  const winner =
    game.score.p1 > game.score.p2 ? tagWithBadge(game, "p1") :
    game.score.p2 > game.score.p1 ? tagWithBadge(game, "p2") :
    "Tie";

  return new EmbedBuilder()
    .setTitle("Recap")
    .setDescription(`${gameHeaderText(game)}`)
    .addFields(
      { name: "Rounds", value: recapLines.join("\n") || "No rounds played.", inline: false },
      {
        name: "Game Stats",
        value:
          `${EMOJI.rock} Rock Wins: ${game.winsByMove.rock}\n` +
          `${EMOJI.paper} Paper Wins: ${game.winsByMove.paper}\n` +
          `${EMOJI.scissors} Scissors Wins: ${game.winsByMove.scissors}`,
        inline: false,
      },
      {
        name: `${tagWithBadge(game, "p1")}'s Stats`,
        value:
          `${EMOJI.rock} Rocks Played: ${p1Counts.rock}\n` +
          `${EMOJI.paper} Papers Played: ${p1Counts.paper}\n` +
          `${EMOJI.scissors} Scissors Played: ${p1Counts.scissors}`,
        inline: true,
      },
      {
        name: `${tagWithBadge(game, "p2")}'s Stats`,
        value:
          `${EMOJI.rock} Rocks Played: ${p2Counts.rock}\n` +
          `${EMOJI.paper} Papers Played: ${p2Counts.paper}\n` +
          `${EMOJI.scissors} Scissors Played: ${p2Counts.scissors}`,
        inline: true,
      },
      {
        name: "Result",
        value: `**${winner} wins!** (${game.score.p1}-${game.score.p2}) ${EMOJI.win}`,
        inline: false,
      }
    );
}


async function postNewPrompt(channel, game) {
  if (game.finished) return;

  game.current = {
    p1Move: null,
    p2Move: null,
    startedAt: Date.now(),
    timeout: null,
    promptMessageId: null,
    resolved: false,
    roundId: (game.roundId = (game.roundId || 0) + 1),
  };

  const embed = new EmbedBuilder()
    .setTitle("Choose Your Move")
    .setDescription(
      `${gameHeaderText(game)}\n\n` +
      `${scoreLine(game)}\n\n` +
      `Moves stay hidden until both players lock.\n\n` +
      `${waitingLine(game)}`
    );

  const msg = await channel.send({
    embeds: [embed],
    components: [moveRow(game.id)],
  });

  game.current.promptMessageId = msg.id;

  if (game.current.timeout) clearTimeout(game.current.timeout);
  game.current.timeout = setTimeout(async () => {
    if (game.finished) return;

    game.finished = true;
    try {
      await msg.edit({
        content: `⏱️ Round timed out.\nMatch ended (no contest).`,
        embeds: [],
        components: [disabledMoveRow(game.id)],
      });
    } catch {}

    cleanupGame(game.id);
  }, MOVE_TIMEOUT_MS);
}

async function disablePromptButtons(channel, game) {
  const pid = game.current?.promptMessageId;
  if (!pid) return;
  try {
    const m = await channel.messages.fetch(pid);
    await m.edit({ components: [disabledMoveRow(game.id)] });
  } catch {}
}

async function finishMatch(channel, game, extra = {}) {
  if (game.finishedPosted) return;
  game.finishedPosted = true;
  game.finished = true;

  if (game.current?.timeout) clearTimeout(game.current.timeout);

  await disablePromptButtons(channel, game);
  await channel.send({ embeds: [recapEmbed(game)] }).catch(() => {});

  // notify wager module if requested
  try {
    if (typeof game.onMatchEnd === "function") {
      const winnerId =
        game.score.p1 > game.score.p2 ? game.p1.id :
        game.score.p2 > game.score.p1 ? game.p2.id :
        null;
      await game.onMatchEnd({ winnerId, ...extra });
    }
  } catch {}

  cleanupGame(game.id);
}

function cleanupGame(gameId) {
  const g = activeGames.get(gameId);
  if (!g) return;

  clearInGame(g.p1.id, g.p2.id);
  activeGames.delete(gameId);
}


export async function startRpsMatch(channel, guild, p1Id, p2Id, opts = {}) {
  const allowAnyChannel = !!opts.allowAnyChannel;
  const onMatchEnd = typeof opts.onMatchEnd === "function" ? opts.onMatchEnd : null;

  if (!channel || !guild) throw new Error("startRpsMatch: missing channel/guild");
  if (!p1Id || !p2Id || p1Id === p2Id) throw new Error("startRpsMatch: bad players");

  if (!ensureNotInGame(p1Id) || !ensureNotInGame(p2Id)) {
    throw new Error("startRpsMatch: one of the players is already busy");
  }

  const gameId = gid();

  await guild.members.fetch({ user: [p1Id, p2Id] }).catch(() => {});
  const p1Member = await guild.members.fetch(p1Id).catch(() => null);
  const p2Member = await guild.members.fetch(p2Id).catch(() => null);

  const p1Badge = p1Member ? getMemberBadgeEmoji(guild, p1Member) : EMOJI.defaultBadge;
  const p2Badge = p2Member ? getMemberBadgeEmoji(guild, p2Member) : EMOJI.defaultBadge;

  const game = {
    id: gameId,
    channelId: channel.id,
    accepted: true,
    finished: false,
    finishedPosted: false,
    winPosted: false,
    roundId: 0,
    allowAnyChannel,
    onMatchEnd,
    p1: { id: p1Id, tag: p1Member?.user?.username || "Player1", badge: p1Badge },
    p2: { id: p2Id, tag: p2Member?.user?.username || "Player2", badge: p2Badge },
    score: { p1: 0, p2: 0 },
    winsByMove: { rock: 0, paper: 0, scissors: 0 },
    rounds: [],
    current: { p1Move: null, p2Move: null, timeout: null, promptMessageId: null, resolved: false, roundId: 0 },
    challengeMessage: null,
  };

  activeGames.set(gameId, game);
  markInGame(gameId, p1Id, p2Id);

  await channel.send(` Match starting! ${gameHeaderText(game)}\nFirst to **${FIRST_TO}** wins.`).catch(() => {});
  await postNewPrompt(channel, game);
  return gameId;
}


export async function endRpsMatchByUsers(channel, userIdA, userIdB, opts = {}) {
  const silent = !!opts.silent;
  const endedByAdmin = !!opts.endedByAdmin;

  for (const game of activeGames.values()) {
    const ids = [game.p1.id, game.p2.id];
    const match = ids.includes(userIdA) && ids.includes(userIdB) && userIdA !== userIdB;
    if (!match) continue;

    if (game.finished) return true;

    game.finished = true;
    game.finishedPosted = true;
    game.winPosted = true;

    try { if (game.current?.timeout) clearTimeout(game.current.timeout); } catch {}
    try { if (channel) await disablePromptButtons(channel, game); } catch {}

    if (!silent && channel) {
      await channel.send(` **Match ended by admin.** <@${game.p1.id}> <@${game.p2.id}>`).catch(() => {});
    }

    // IMPORTANT: notify wager module as "endedByAdmin" with no winner
    try {
      if (typeof game.onMatchEnd === "function") {
        await game.onMatchEnd({ winnerId: null, endedByAdmin });
      }
    } catch {}

    cleanupGame(game.id);
    return true;
  }
  return false;
}

async function handleButton(interaction) {
  if (!interaction.isButton()) return;

  const customId = String(interaction.customId || "");
  if (!customId.startsWith("rps:")) return;

  if (seenInteractionIds.has(interaction.id)) return;
  seenInteractionIds.add(interaction.id);

  const parts = customId.split(":");
  const gameId = parts[1];
  const action = parts[2];

  const game = activeGames.get(gameId);
  if (!game) {
    await interaction.reply({ content: "This game no longer exists.", ephemeral: true }).catch(() => {});
    return;
  }

  const chanId = interaction.channel?.id;
  if (!game.allowAnyChannel && !ALLOWED_RPS_CHANNEL_IDS.has(chanId)) {
    await interaction.reply({
      content: "❌ RPS interactions are disabled in this channel.",
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  if (game.finished) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  const uid = interaction.user.id;
  const isP1 = uid === game.p1.id;
  const isP2 = uid === game.p2.id;

  if (!isP1 && !isP2) {
    await interaction.reply({ content: "You are not a player in this match.", ephemeral: true }).catch(() => {});
    return;
  }

  // Accept/Decline phase (only for normal challenges)
  if (!game.accepted && (action === "accept" || action === "decline")) {
    await interaction.deferUpdate().catch(() => {});
    if (!isP2) return;

    if (action === "decline") {
      game.finished = true;
      game.finishedPosted = true;
      try {
        await game.challengeMessage.edit({
          content: `Challenge declined by ${tagWithBadge(game, "p2")}.`,
          components: [],
        });
      } catch {}
      cleanupGame(game.id);
      return;
    }

    game.accepted = true;
    try {
      await game.challengeMessage.edit({
        content: `Challenge accepted! Players, to your buttons!`,
        components: [],
      });
    } catch {}

    const channel = interaction.channel;
    if (!channel) return;

    await postNewPrompt(channel, game);
    return;
  }

  // Move phase
  if (action === "move") {
    await interaction.deferUpdate().catch(() => {});
    if (!game.accepted || game.finished) return;

    const move = parts[3];
    if (!["rock", "paper", "scissors"].includes(move)) return;

    const currentPromptId = game.current?.promptMessageId;
    if (currentPromptId && interaction.message?.id !== currentPromptId) return;

    if (game.current?.resolved) return;

    if (isP1) game.current.p1Move = move;
    if (isP2) game.current.p2Move = move;

    try {
      const embed = new EmbedBuilder()
        .setTitle("Choose Your Move")
        .setDescription(
          `${gameHeaderText(game)}\n\n` +
          `${scoreLine(game)}\n\n` +
          `Moves stay hidden until both players lock.\n\n` +
          `${waitingLine(game)}`
        );
      await interaction.message.edit({ embeds: [embed], components: [moveRow(game.id)] });
    } catch {}

    if (game.current.p1Move && game.current.p2Move) {
      if (game.current.resolved) return;
      game.current.resolved = true;

      if (game.current?.timeout) {
        clearTimeout(game.current.timeout);
        game.current.timeout = null;
      }

      const channel = interaction.channel;
      if (!channel) return;

      await disablePromptButtons(channel, game);

      const p1Move = game.current.p1Move;
      const p2Move = game.current.p2Move;

      const winner = decide(p1Move, p2Move);

      let roundText = "";
      if (winner === 0) {
        roundText = `Tie! ${prettyMove(p1Move)} equals ${prettyMove(p2Move)} — no point.`;
      } else if (winner === 1) {
        game.score.p1 = Math.min(FIRST_TO, game.score.p1 + 1);
        game.winsByMove[p1Move] = (game.winsByMove[p1Move] || 0) + 1;
        roundText = `${prettyMove(p1Move)} beats ${prettyMove(p2Move)}! ${tagWithBadge(game, "p1")} gains a point!`;
      } else {
        game.score.p2 = Math.min(FIRST_TO, game.score.p2 + 1);
        game.winsByMove[p2Move] = (game.winsByMove[p2Move] || 0) + 1;
        roundText = `${prettyMove(p2Move)} beats ${prettyMove(p1Move)}! ${tagWithBadge(game, "p2")} gains a point!`;
      }

      game.rounds.push({
        p1Move,
        p2Move,
        scoreAfter: { p1: game.score.p1, p2: game.score.p2 },
      });

      const resultsEmbed = new EmbedBuilder()
        .setTitle("RESULTS")
        .setDescription(
          `${gameHeaderText(game)}\n\n` +
          `${moveEmoji(p1Move)} vs ${moveEmoji(p2Move)}\n` +
          `${roundText}\n\n` +
          `${scoreLine(game)}`
        );

      await channel.send({ embeds: [resultsEmbed] });

      if (game.score.p1 >= FIRST_TO || game.score.p2 >= FIRST_TO) {
        const winTag = game.score.p1 > game.score.p2 ? tagWithBadge(game, "p1") : tagWithBadge(game, "p2");
        if (!game.winPosted) {
          game.winPosted = true;
          await channel.send(`**${winTag} wins!** (${game.score.p1}-${game.score.p2}) ${EMOJI.win}`);
        }
        await finishMatch(channel, game);
        return;
      }

      await postNewPrompt(channel, game);
    }
  }
}


function isAdminMember(message) {
  return Boolean(message.member?.permissions?.has("Administrator"));
}

async function forceEndGameByUsers(message, userIdA, userIdB) {
  const ended = await endRpsMatchByUsers(message.channel, userIdA, userIdB, { endedByAdmin: true });
  if (!ended) {
    await message.reply("No active match found for those two players.").catch(() => {});
  }
}


async function handleMessage(message) {
  if (!message?.content) return;
  if (message.author.bot) return;

  const content = String(message.content || "").trim();
  if (!content.toLowerCase().startsWith(PREFIX)) return;

  const tokens = content.split(/\s+/);
  const sub = (tokens[1] || "").toLowerCase();

  // ✅ IMPORTANT: prevent double-handling admin end in wager channels
  if (sub === "end" && WAGER_RPS_CHANNEL_IDS.has(message.channel.id)) {
    return; // wager-rps
  }

  // ✅ Allow admin %rps end in normal channels
  if (sub === "end") {
    if (!isAdminMember(message)) {
      await message.reply("❌ You must be an Administrator to use this command.").catch(() => {});
      return;
    }
    const aId = tokens[2] ? parseMention(tokens[2]) : null;
    const bId = tokens[3] ? parseMention(tokens[3]) : null;
    if (!aId || !bId) {
      await message.reply(`Usage: \`${PREFIX} end @player1 @player2\``).catch(() => {});
      return;
    }
    await forceEndGameByUsers(message, aId, bId);
    return;
  }

  // ✅ Normal RPS ignores wager channels completely
  if (WAGER_RPS_CHANNEL_IDS.has(message.channel.id)) return;

  // ✅ If someone tries "%rps wager 
  if (sub === "wager") return;

  // ✅ Only block normal %rps commands in disallowed channels
  if (!ALLOWED_RPS_CHANNEL_IDS.has(message.channel.id)) {
    await message.reply("❌ RPS games are not allowed in this channel.").catch(() => {});
    return;
  }

  if (sub !== "challenge") {
    await message.reply(`Usage: \`${PREFIX} challenge @user\``).catch(() => {});
    return;
  }

  const mentionToken = tokens[2];
  if (!mentionToken || !isMentionedUser(mentionToken)) {
    await message.reply(`You must mention a user.\nExample: \`${PREFIX} challenge @user\``).catch(() => {});
    return;
  }

  const p1 = message.author;
  const p2Id = parseMention(mentionToken);

  if (!p2Id) { await message.reply("Could not parse that mention.").catch(() => {}); return; }
  if (p2Id === p1.id) { await message.reply("You can't challenge yourself.").catch(() => {}); return; }

  const p2 = await message.client.users.fetch(p2Id).catch(() => null);
  if (!p2) { await message.reply("Could not find that user.").catch(() => {}); return; }

  if (!ensureNotInGame(p1.id)) { await message.reply("You're already in an active RPS match (or wager).").catch(() => {}); return; }
  if (!ensureNotInGame(p2.id)) { await message.reply("That user is already in an active RPS match (or wager).").catch(() => {}); return; }

  const gameId = gid();

  const guild = await message.guild.fetch();
  await guild.members.fetch({ user: [p1.id, p2.id] }).catch(() => {});

  const p1Member = await guild.members.fetch(p1.id).catch(() => null);
  const p2Member = await guild.members.fetch(p2.id).catch(() => null);

  const p1Badge = p1Member ? getMemberBadgeEmoji(guild, p1Member) : EMOJI.defaultBadge;
  const p2Badge = p2Member ? getMemberBadgeEmoji(guild, p2Member) : EMOJI.defaultBadge;

  const game = {
    id: gameId,
    channelId: message.channel.id,
    accepted: false,
    finished: false,
    finishedPosted: false,
    winPosted: false,
    roundId: 0,
    allowAnyChannel: false,
    onMatchEnd: null,
    p1: { id: p1.id, tag: p1.username, badge: p1Badge },
    p2: { id: p2.id, tag: p2.username, badge: p2Badge },
    score: { p1: 0, p2: 0 },
    winsByMove: { rock: 0, paper: 0, scissors: 0 },
    rounds: [],
    current: { p1Move: null, p2Move: null, timeout: null, promptMessageId: null, resolved: false, roundId: 0 },
    challengeMessage: null,
  };

  activeGames.set(gameId, game);
  markInGame(gameId, p1.id, p2.id);

  const challengeText =
    `Challenge started! Player 2, please click **Accept**.\n` +
    `${gameHeaderText(game)}\n` +
    `First to **${FIRST_TO}** wins.`;

  game.challengeMessage = await message.channel.send({
    content: challengeText,
    components: [challengeRow(gameId)],
  });

  setTimeout(async () => {
    const g = activeGames.get(gameId);
    if (!g || g.accepted || g.finished) return;

    g.finished = true;
    g.finishedPosted = true;
    try {
      await g.challengeMessage.edit({ content: "Challenge expired (no response).", components: [] });
    } catch {}
    cleanupGame(game.id);
  }, CHALLENGE_TIMEOUT_MS);
}


export function setupRpsGame(client) {
  client.on("messageCreate", (message) => {
    handleMessage(message).catch((e) => console.error("❌ RPS message handler error:", e));
  });

  client.on("interactionCreate", (interaction) => {
    handleButton(interaction).catch((e) => console.error("❌ RPS button handler error:", e));
  });

  console.log(`✅ RPS module loaded | Use: ${PREFIX} challenge @user | first-to-${FIRST_TO}`);
}
