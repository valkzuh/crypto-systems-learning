const CONFIG = {
  // Helius RPC URL
  RPC_URL: "",

  // SRPSL token mint
  TOKEN_MINT: "",

  // sheet tab names
  ROSTER_SHEET: "ROSTER_SHEET",
  LOCKS_SHEET:  "LOCKS_SHEET",

  START_ROW: 2,
  R_COL_DISCORD: 2,
  R_COL_WALLET:  3,

  R_COL_HOLD_BALANCE: 5,
  R_COL_PLAYER_OK: 6,
  R_COL_ELITE_OK:  7,
  R_COL_MGR_BAL_OK: 8,

  R_COL_LASTCHECK: 9,

  R_COL_LOCKED: 10,           
  R_COL_TOTAL:  11,          
  R_COL_MGR_TOTAL_OK: 12,    

  /** LOCKS COLUMNS */
  L_COL_DISCORD: 2,
  L_COL_WALLET:  3,
  L_COL_STREAM_ID: 4,

  // Gates
  PLAYER_MIN: 50000,
  ELITE_MIN: 200000,
  MANAGER_MIN: 1000000,

  // Batch controls
  BATCH_SIZE: 50,

  // SECURITY: shared secret for bot -> Apps Script POST updates
  POST_SHARED_SECRET: ""
};

/**
 * Run on a time trigger (every 5–10 min)
 * Checks HOLD balances and writes tier booleans to roster sheet.
 */
function checkEligibilityBatch() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.ROSTER_SHEET);
  if (!sheet) throw new Error("Roster sheet not found: " + CONFIG.ROSTER_SHEET);

  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.START_ROW) return;

  const numRows = lastRow - CONFIG.START_ROW + 1;

  const discordVals = sheet.getRange(CONFIG.START_ROW, CONFIG.R_COL_DISCORD, numRows, 1).getValues();
  const walletVals  = sheet.getRange(CONFIG.START_ROW, CONFIG.R_COL_WALLET,  numRows, 1).getValues();

  const rows = [];
  for (let i = 0; i < numRows; i++) {
    const discordId = (discordVals[i][0] || "").toString().trim();
    const wallet    = (walletVals[i][0]  || "").toString().trim();
    if (!discordId || !wallet) continue;
    rows.push({ idx: i, discordId, wallet });
  }
  if (!rows.length) return;

  const cursor = getCursor_();
  let slice = rows.slice(cursor, cursor + CONFIG.BATCH_SIZE);
  if (slice.length < CONFIG.BATCH_SIZE && rows.length > slice.length) {
    slice = slice.concat(rows.slice(0, CONFIG.BATCH_SIZE - slice.length));
  }
  setCursor_((cursor + CONFIG.BATCH_SIZE) % rows.length);

  const now = new Date();

  for (const r of slice) {
    const bal = getSplTokenBalance_(r.wallet, CONFIG.TOKEN_MINT);

    sheet.getRange(CONFIG.START_ROW + r.idx, CONFIG.R_COL_HOLD_BALANCE).setValue(bal);
    sheet.getRange(CONFIG.START_ROW + r.idx, CONFIG.R_COL_PLAYER_OK).setValue(bal >= CONFIG.PLAYER_MIN);
    sheet.getRange(CONFIG.START_ROW + r.idx, CONFIG.R_COL_ELITE_OK).setValue(bal >= CONFIG.ELITE_MIN);
    sheet.getRange(CONFIG.START_ROW + r.idx, CONFIG.R_COL_MGR_BAL_OK).setValue(bal >= CONFIG.MANAGER_MIN); // legacy
    sheet.getRange(CONFIG.START_ROW + r.idx, CONFIG.R_COL_LASTCHECK).setValue(now);

    // NOTE: Locked/Total/ManagerTotalOk are written by bot via doPost()
  }
}

/**
 * run manually once after you start collecting lock submissions.
 * Converts Streamflow URLs into just Stream IDs in the LOCKS sheet.
 */
function normalizeLocksSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.LOCKS_SHEET);
  if (!sheet) throw new Error("Locks sheet not found: " + CONFIG.LOCKS_SHEET);

  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.START_ROW) return;

  const numRows = lastRow - CONFIG.START_ROW + 1;
  const vals = sheet.getRange(CONFIG.START_ROW, CONFIG.L_COL_STREAM_ID, numRows, 1).getValues();

  for (let i = 0; i < numRows; i++) {
    const raw = (vals[i][0] || "").toString().trim();
    if (!raw) continue;
    const id = normalizeStreamflowId_(raw);
    if (id && id !== raw) {
      sheet.getRange(CONFIG.START_ROW + i, CONFIG.L_COL_STREAM_ID).setValue(id);
    }
  }
}

/**
 * Discord bot calls
 * Returns roster + wallet->streamIds mapping.
 */
function doGet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const roster = ss.getSheetByName(CONFIG.ROSTER_SHEET);
  const locks  = ss.getSheetByName(CONFIG.LOCKS_SHEET);

  if (!roster) return json_({ ok: false, error: "Roster sheet missing" });
  if (!locks)  return json_({ ok: false, error: "Locks sheet missing" });

  // ---- roster export
  const rLast = roster.getLastRow();
  const rNum = Math.max(0, rLast - CONFIG.START_ROW + 1);

  const rDiscord = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_DISCORD, rNum, 1).getValues() : [];
  const rWallet  = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_WALLET,  rNum, 1).getValues() : [];
  const rHold    = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_HOLD_BALANCE, rNum, 1).getValues() : [];
  const rPlayer  = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_PLAYER_OK, rNum, 1).getValues() : [];
  const rElite   = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_ELITE_OK,  rNum, 1).getValues() : [];
  const rMgrBal  = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_MGR_BAL_OK, rNum, 1).getValues() : [];

  // Optional existing bot outputs (not required, but nice to include)
  const rLocked  = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_LOCKED, rNum, 1).getValues() : [];
  const rTotal   = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_TOTAL,  rNum, 1).getValues() : [];
  const rMgrTot  = rNum ? roster.getRange(CONFIG.START_ROW, CONFIG.R_COL_MGR_TOTAL_OK, rNum, 1).getValues() : [];

  const rosterData = [];
  for (let i = 0; i < rNum; i++) {
    const discordId = (rDiscord[i][0] || "").toString().trim();
    const wallet    = (rWallet[i][0]  || "").toString().trim();
    if (!discordId || !wallet) continue;

    const hold = Number(rHold[i][0] || 0) || 0;

    rosterData.push({
      discordId,
      wallet,

      // HOLD is exported as "balance"
      balance: round6_(hold),

      playerOk: Boolean(rPlayer[i][0]),
      eliteOk: Boolean(rElite[i][0]),
      managerBalanceOk: Boolean(rMgrBal[i][0]),

      // optional: current bot outputs (can help debug)
      locked: Number(rLocked[i][0] || 0) || 0,
      total:  Number(rTotal[i][0] || 0) || 0,
      managerTotalOk: Boolean(rMgrTot[i][0])
    });
  }

  // ---- locks export: wallet -> [streamIds]
  const lLast = locks.getLastRow();
  const lNum = Math.max(0, lLast - CONFIG.START_ROW + 1);

  const lWallet = lNum ? locks.getRange(CONFIG.START_ROW, CONFIG.L_COL_WALLET,    lNum, 1).getValues() : [];
  const lStream = lNum ? locks.getRange(CONFIG.START_ROW, CONFIG.L_COL_STREAM_ID, lNum, 1).getValues() : [];

  const lockMap = {};
  for (let i = 0; i < lNum; i++) {
    const wallet = (lWallet[i][0] || "").toString().trim();
    const rawStream = (lStream[i][0] || "").toString().trim();
    if (!wallet || !rawStream) continue;

    const streamId = normalizeStreamflowId_(rawStream);
    if (!streamId) continue;

    if (!lockMap[wallet]) lockMap[wallet] = [];
    lockMap[wallet].push(streamId);
  }

  return json_({
    ok: true,
    config: {
      tokenMint: CONFIG.TOKEN_MINT,
      gates: {
        playerMin: CONFIG.PLAYER_MIN,
        eliteMin: CONFIG.ELITE_MIN,
        managerMin: CONFIG.MANAGER_MIN
      }
    },
    roster: rosterData,
    locks: lockMap
  });
}

/**
 * bot calls this (POST) to write LOCKED/TOTAL/ManagerTotalOk into roster sheet.
 */
function doPost(e) {
  try {
    const body = JSON.parse(e?.postData?.contents || "{}");

    if (!body || body.secret !== CONFIG.POST_SHARED_SECRET) {
      return json_({ ok: false, error: "Unauthorized" });
    }

    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (!updates.length) return json_({ ok: true, updated: 0 });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.ROSTER_SHEET);
    if (!sheet) return json_({ ok: false, error: "Roster sheet missing" });

    const lastRow = sheet.getLastRow();
    if (lastRow < CONFIG.START_ROW) return json_({ ok: true, updated: 0 });

    const numRows = lastRow - CONFIG.START_ROW + 1;

    // Build wallet -> rowIndex map from sheet
    const walletVals = sheet.getRange(CONFIG.START_ROW, CONFIG.R_COL_WALLET, numRows, 1).getValues();
    const walletToRow = {};
    for (let i = 0; i < numRows; i++) {
      const w = (walletVals[i][0] || "").toString().trim();
      if (w) walletToRow[w] = CONFIG.START_ROW + i;
    }

    let updated = 0;

    // Batch write using ranges (faster)
    for (const u of updates) {
      const wallet = (u.wallet || "").toString().trim();
      if (!wallet) continue;

      const row = walletToRow[wallet];
      if (!row) continue;

      const locked = Number(u.locked || 0) || 0;
      const total  = Number(u.total  || 0) || 0;
      const mgrOk  = Boolean(u.managerTotalOk);

      sheet.getRange(row, CONFIG.R_COL_LOCKED).setValue(round6_(locked));
      sheet.getRange(row, CONFIG.R_COL_TOTAL).setValue(round6_(total));
      sheet.getRange(row, CONFIG.R_COL_MGR_TOTAL_OK).setValue(mgrOk);

      updated++;
    }

    return json_({ ok: true, updated });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// -------------------- helpers --------------------

function normalizeStreamflowId_(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  const parts = s.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  return last.trim();
}

function round6_(n) {
  const x = Number(n || 0) || 0;
  return Math.floor(x * 1000000) / 1000000;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSplTokenBalance_(ownerAddress, mintAddress) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [ownerAddress, { mint: mintAddress }, { encoding: "jsonParsed" }]
  };

  try {
    const res = UrlFetchApp.fetch(CONFIG.RPC_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return 0;

    const json = JSON.parse(res.getContentText());
    const accounts = json?.result?.value || [];
    let total = 0;

    for (const acc of accounts) {
      const info = acc?.account?.data?.parsed?.info;
      total += Number(info?.tokenAmount?.uiAmount || 0);
    }
    return round6_(total);
  } catch {
    return 0;
  }
}

function getCursor_() {
  const props = PropertiesService.getScriptProperties();
  const v = props.getProperty("SRPSL_CURSOR");
  const n = v ? parseInt(v, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function setCursor_(n) {
  PropertiesService.getScriptProperties().setProperty("SRPSL_CURSOR", String(n));
}
function resetCursor() {
  setCursor_(0);
}
