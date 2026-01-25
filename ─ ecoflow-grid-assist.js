// =================== EcoFlow Grid-Assist Controller  =======================================================
//
// What this does
// - Reads grid power from MT175 (GRID_W):  +W = import, -W = export
// - Writes a value to EcoFlow via ECOFLOW_SET (dayResidentLoadList.loadPower1).
//   In self-powered operation this acts as the “virtual meter / home load” feed that EcoFlow uses in the app.
// - Runs a simple integral controller to keep grid import near TARGET_IMPORT_W (only when discharge is allowed).
//
// Key behaviors
// 1) CONTROL (SoC gate open):
//    - Controller computes u (0..800 W) to reduce grid import toward TARGET_IMPORT_W
//    - Writes u to ECOFLOW_SET
// 2) FALLBACK_SOC (SoC gate closed, SoC <= reserve):
//    - Discharging is blocked (internal u is held at 0)
//    - BUT we still feed EcoFlow display with current grid import:
//      ECOFLOW_SET = max(0, grid_raw_w)
//    This keeps EcoFlow Home/Grid values updating even when battery is at reserve.
//
// Strategy monitoring (log only)
// - Logs an ERROR if energyStrategyOperateMode is not {"operateSelfPoweredOpen":1} (rate-limited)
//
// Keepalive
// - Re-sends the last written ECOFLOW_SET value every KEEPALIVE_MS
//
// -------------------------------------------------------------------------------------------------------------

// ------------------- IDs (YOUR SETUP) -------------------
const GRID_W         = 'sonoff.0.Energymeter.METERID_Power_cur';
const ECOFLOW_SET    = 'ecoflow-mqtt.0.MASTER_ID.dayResidentLoadList.loadPower1';

const SOC            = 'ecoflow-mqtt.0.MASTER_ID.DisplayPropertyUpload.cmsBattSoc';
const SOC_RES        = 'ecoflow-mqtt.0.MASTER_ID.DisplayPropertyUpload.backupReverseSoc';
const BMS_STATE      = 'ecoflow-mqtt.0.MASTER_ID.DisplayPropertyUpload.bmsChgDsgState';

// EcoFlow net power as shown by EcoFlow app (your validation)
const ECOFLOW_OUT_W  = 'ecoflow-mqtt.0.MASTER_ID.DisplayPropertyUpload.gridConnectionPower';

// Strategy mode (log-only monitoring)
const EF_STRATEGY    = 'ecoflow-mqtt.0.MASTER_ID.DisplayPropertyUpload.energyStrategyOperateMode';

// ------------------- Debug base -------------------
const DBG_BASE = '0_userdata.0.ecoflow.ctrl';

// ------------------- Limits -------------------
const U_MIN = 0;
const U_MAX = 800;

// ------------------- Target -------------------
const TARGET_IMPORT_W = 20;

// ------------------- Grid filter (used for control only) -------------------
const GRID_ALPHA = 0.25;
const GRID_ZERO_BAND_W = 10;

// ------------------- Controller -------------------
const DEADBAND_W = 10;
const KI_PER_SEC = 0.08;
const MAX_STEP_W = 60;

// ------------------- Writes -------------------
const WRITE_EVERY_MS  = 3000;
const MIN_SEND_STEP_W = 8;

// ------------------- Keepalive -------------------
const KEEPALIVE_MS       = 60000;
const KEEPALIVE_TICK_MS  = 5000;

// ------------------- Strategy monitor (LOG ONLY) -------------------
const STRATEGY_ERROR_MIN_INTERVAL_MS = 5 * 60 * 1000; // log at most once per 5 minutes
let lastStrategyErrorTs = 0;
let lastStrategyRaw = null;

// ------------------- SoC gate -------------------
const SOC_ON_MARGIN = 1; // hysteresis margin in %
let soc = 0;
let socRes = 20;
let socGate = true;

// ------------------- BMS (debug only) -------------------
let bms = '';

// ------------------- Internals -------------------
let gridRaw = 0;
let gridFilt = 0;
let lastGridTs = 0;

let ecoOut = 0; // signed: + supplies house, - absorbs/charges (as reported by adapter/app)
let u = 0;      // internal controller setpoint (0..800)

let lastWriteTs = 0;
let lastWritten = null; // IMPORTANT: last value actually written to ECOFLOW_SET
let lastKeepaliveTs = 0;

let lastUpdateTs = 0;
let mode = 'INIT';

// ------------------- Output-authority gating -------------------
// Only allow ramp-up when EcoFlow is actually supplying OR a small start kick is justified.
const EF_OUTPUT_ON_W = 10;    // ecoOut > 10W means EcoFlow is supplying
const START_KICK_U_W = 80;    // allow ramp-up when u is still small
const START_KICK_ERR_W = 60;  // and grid import is clearly above target

// ------------------- Helpers -------------------
function clamp(v, lo, hi){ return Math.min(Math.max(v, lo), hi); }
function toNumber(val){ return parseFloat(String(val).replace(',', '.')); }

function updateSocGate(){
  // Close gate at/below reserve; open again with hysteresis.
  if (socGate && soc <= socRes) socGate = false;
  if (!socGate && soc >= (socRes + SOC_ON_MARGIN)) socGate = true;
}

// ECOFLOW_SET is a display feed into EcoFlow.
// We write either controller u (control mode) or grid import (fallback mode).
function maybeWrite(targetVal, forceKeepalive=false){
  const now = Date.now();
  const tv = Math.round(clamp(targetVal, U_MIN, U_MAX));

  const dueByInterval  = (now - lastWriteTs) >= WRITE_EVERY_MS;
  const dueByKeepalive = forceKeepalive || (now - lastKeepaliveTs) >= KEEPALIVE_MS;

  if (!dueByInterval && !dueByKeepalive) return;

  // Skip tiny deltas unless keepalive is due
  if (dueByInterval && !dueByKeepalive && lastWritten !== null && Math.abs(tv - lastWritten) < MIN_SEND_STEP_W) return;

  setState(ECOFLOW_SET, tv, false);

  lastWritten = tv;
  lastWriteTs = now;
  if (dueByKeepalive) lastKeepaliveTs = now;
}

// ------------------- Debug states -------------------
function ensureState(id, def, common){
  createState(id, def, common);
}

function ensureMeta(id, meta){
  try {
    const obj = getObject(id);
    if (!obj || !obj.common) return;
    let changed = false;

    for (const k of Object.keys(meta)) {
      if (obj.common[k] !== meta[k]) {
        obj.common[k] = meta[k];
        changed = true;
      }
    }
    if (changed) setObject(id, obj);
  } catch (e) {
    // ignore
  }
}

function initDebugStates(){
  // Grid / meter
  ensureState(`${DBG_BASE}.grid_raw_w`, 0,        {type:'number', read:true, write:false, unit:'W'});
  ensureState(`${DBG_BASE}.grid_filt_w`, 0,       {type:'number', read:true, write:false, unit:'W'});
  ensureState(`${DBG_BASE}.grid_import_w`, 0,     {type:'number', read:true, write:false, unit:'W'});
  ensureState(`${DBG_BASE}.grid_export_w`, 0,     {type:'number', read:true, write:false, unit:'W'});

  // EcoFlow (as reported)
  ensureState(`${DBG_BASE}.ecoflow_out_w`, 0,     {type:'number', read:true, write:false, unit:'W'});
  ensureState(`${DBG_BASE}.ecoflow_discharge_w`,0,{type:'number', read:true, write:false, unit:'W'});
  ensureState(`${DBG_BASE}.ecoflow_charge_w`, 0,  {type:'number', read:true, write:false, unit:'W'});

  // Derived / estimate
  ensureState(`${DBG_BASE}.house_load_est_w`, 0,  {type:'number', read:true, write:false, unit:'W'});

  // Controller
  ensureState(`${DBG_BASE}.u_set_w`, 0,           {type:'number', read:true, write:false, unit:'W'});
  ensureState(`${DBG_BASE}.target_import_w`, TARGET_IMPORT_W, {type:'number', read:true, write:false, unit:'W'});

  // Battery / gate / status
  ensureState(`${DBG_BASE}.soc`, 0,               {type:'number', read:true, write:false, unit:'%'});
  ensureState(`${DBG_BASE}.soc_res`, 0,           {type:'number', read:true, write:false, unit:'%'});
  ensureState(`${DBG_BASE}.soc_gate`, false,      {type:'boolean', read:true, write:false});
  ensureState(`${DBG_BASE}.discharging`, false,   {type:'boolean', read:true, write:false});
  ensureState(`${DBG_BASE}.bms_state`, '',        {type:'string', read:true, write:false});

  // Misc
  ensureState(`${DBG_BASE}.mode`, 'INIT',         {type:'string', read:true, write:false});
  ensureState(`${DBG_BASE}.last_update_age_s`, 0, {type:'number', read:true, write:false, unit:'s'});
}

function initMeta(){
  ensureMeta(`${DBG_BASE}.grid_raw_w`, {
    name: 'Grid power (raw)',
    desc: 'Raw power at the utility meter (MT175). Positive = import. Negative = export.',
    role: 'value.power'
  });
  ensureMeta(`${DBG_BASE}.grid_filt_w`, {
    name: 'Grid power (filtered)',
    desc: 'Filtered grid power (EMA). Used for control only.',
    role: 'value.power'
  });
  ensureMeta(`${DBG_BASE}.grid_import_w`, {
    name: 'Grid import',
    desc: 'Derived as max(0, grid_raw_w).',
    role: 'value.power'
  });
  ensureMeta(`${DBG_BASE}.grid_export_w`, {
    name: 'Grid export',
    desc: 'Derived as max(0, -grid_raw_w).',
    role: 'value.power'
  });

  ensureMeta(`${DBG_BASE}.ecoflow_out_w`, {
    name: 'EcoFlow net power (app)',
    desc: 'Signed EcoFlow power reported by adapter/app. Positive = supplies house. Negative = absorbs/charges.',
    role: 'value.power'
  });
  ensureMeta(`${DBG_BASE}.ecoflow_discharge_w`, {
    name: 'EcoFlow discharge to house',
    desc: 'Derived as max(0, ecoflow_out_w). Always >= 0 W.',
    role: 'value.power'
  });
  ensureMeta(`${DBG_BASE}.ecoflow_charge_w`, {
    name: 'EcoFlow charge / absorption',
    desc: 'Derived as max(0, -ecoflow_out_w). Always >= 0 W.',
    role: 'value.power'
  });

  ensureMeta(`${DBG_BASE}.house_load_est_w`, {
    name: 'House load estimate',
    desc: 'Estimated house consumption = grid_import_w + ecoflow_discharge_w.',
    role: 'value.power'
  });

  ensureMeta(`${DBG_BASE}.u_set_w`, {
    name: 'Controller setpoint (u)',
    desc: 'Internal controller setpoint in watts (0..800). In FALLBACK_SOC, display feed uses grid import instead.',
    role: 'value.power'
  });

  ensureMeta(`${DBG_BASE}.target_import_w`, {
    name: 'Target grid import',
    desc: 'Desired steady-state grid import in watts.',
    role: 'value'
  });

  ensureMeta(`${DBG_BASE}.mode`, {
    name: 'Controller mode',
    desc: 'Mode: CONTROL_EF_OUTPUT, CONTROL_START_KICK, HOLD_NO_AUTHORITY, FALLBACK_SOC.',
    role: 'text'
  });

  ensureMeta(`${DBG_BASE}.last_update_age_s`, {
    name: 'Last update age',
    desc: 'Seconds since the controller last processed a grid meter update.',
    role: 'value.interval'
  });

  ensureMeta(`${DBG_BASE}.soc`, {
    name: 'Battery state of charge',
    desc: 'Overall battery SoC in percent.',
    role: 'value.battery'
  });

  ensureMeta(`${DBG_BASE}.soc_res`, {
    name: 'Battery reserve SoC',
    desc: 'Configured minimum reserve SoC (backup reserve).',
    role: 'value.battery'
  });

  ensureMeta(`${DBG_BASE}.soc_gate`, {
    name: 'SoC gate open',
    desc: 'true = discharge allowed. false = discharge blocked at/below reserve.',
    role: 'indicator'
  });

  ensureMeta(`${DBG_BASE}.discharging`, {
    name: 'EcoFlow supplying power',
    desc: 'true if ecoflow_out_w > 10 W.',
    role: 'indicator'
  });

  ensureMeta(`${DBG_BASE}.bms_state`, {
    name: 'BMS state (raw)',
    desc: 'Raw BMS charge/discharge state string from EcoFlow.',
    role: 'text'
  });
}

function updateDebugStates(){
  const imp = Math.max(0, gridRaw);
  const exp = Math.max(0, -gridRaw);

  const dis = Math.max(0, ecoOut);
  const chg = Math.max(0, -ecoOut);

  const houseEst = imp + dis;

  setState(`${DBG_BASE}.grid_raw_w`, Math.round(gridRaw), true);
  setState(`${DBG_BASE}.grid_filt_w`, Math.round(gridFilt), true);
  setState(`${DBG_BASE}.grid_import_w`, Math.round(imp), true);
  setState(`${DBG_BASE}.grid_export_w`, Math.round(exp), true);

  setState(`${DBG_BASE}.ecoflow_out_w`, Math.round(ecoOut), true);
  setState(`${DBG_BASE}.ecoflow_discharge_w`, Math.round(dis), true);
  setState(`${DBG_BASE}.ecoflow_charge_w`, Math.round(chg), true);

  setState(`${DBG_BASE}.house_load_est_w`, Math.round(houseEst), true);

  setState(`${DBG_BASE}.u_set_w`, Math.round(u), true);
  setState(`${DBG_BASE}.soc`, Number(soc.toFixed(2)), true);
  setState(`${DBG_BASE}.soc_res`, Number(socRes.toFixed(2)), true);
  setState(`${DBG_BASE}.soc_gate`, !!socGate, true);
  setState(`${DBG_BASE}.discharging`, (ecoOut > EF_OUTPUT_ON_W), true);
  setState(`${DBG_BASE}.bms_state`, String(bms || ''), true);

  setState(`${DBG_BASE}.mode`, mode, true);

  const ageS = lastUpdateTs ? Math.round((Date.now() - lastUpdateTs)/1000) : 9999;
  setState(`${DBG_BASE}.last_update_age_s`, ageS, true);
}

// ------------------- Init debug objects -------------------
initDebugStates();
initMeta();
setState(`${DBG_BASE}.target_import_w`, TARGET_IMPORT_W, true);

// ------------------- Keepalive tick -------------------
setInterval(() => {
  try {
    const forceKeepalive = (Date.now() - lastKeepaliveTs) >= KEEPALIVE_MS;

    // Update age even without grid events
    const ageS = lastUpdateTs ? Math.round((Date.now() - lastUpdateTs)/1000) : 9999;
    setState(`${DBG_BASE}.last_update_age_s`, ageS, true);

    if (forceKeepalive) {
      // Re-send last written ECOFLOW_SET value
      const resend = (lastWritten !== null ? lastWritten : u);
      maybeWrite(resend, true);
      log(`[EFDBG] KEEPALIVE: resent value=${Math.round(resend)}W`, 'info');
    }
  } catch (e) {
    // ignore
  }
}, KEEPALIVE_TICK_MS);

// ------------------- Strategy monitoring (LOG ONLY) -------------------
function logStrategyErrorOnce(reason) {
  const now = Date.now();
  if ((now - lastStrategyErrorTs) < STRATEGY_ERROR_MIN_INTERVAL_MS) return;
  lastStrategyErrorTs = now;
  log(
    `[EFDBG] ERROR: EcoFlow NOT in self-powered mode | energyStrategyOperateMode=${lastStrategyRaw} | expected {"operateSelfPoweredOpen":1} | ${reason}`,
    'error'
  );
}

on({ id: EF_STRATEGY, change: 'any' }, o => {
  const v = o.state.val;
  lastStrategyRaw = (typeof v === 'object') ? JSON.stringify(v) : String(v);

  const ok =
    (typeof v === 'object' && v && v.operateSelfPoweredOpen === 1) ||
    (typeof v === 'string' && v.includes('"operateSelfPoweredOpen":1'));

  if (!ok) logStrategyErrorOnce('operateSelfPoweredOpen != 1');
});

// ------------------- Subscriptions -------------------
on({id: SOC, change:'any'}, o => {
  const n = toNumber(o.state.val);
  if (!isNaN(n)) soc = n;
});

on({id: SOC_RES, change:'any'}, o => {
  const n = toNumber(o.state.val);
  if (!isNaN(n)) socRes = n;
});

on({id: BMS_STATE, change:'any'}, o => {
  bms = String(o.state.val || '');
  updateDebugStates();
});

on({id: ECOFLOW_OUT_W, change:'ne'}, o => {
  const n = toNumber(o.state.val);
  if (!isNaN(n)) ecoOut = n;
  updateDebugStates();
});

// ------------------- Main control loop (on grid updates) -------------------
on({id: GRID_W, change:'ne'}, (obj) => {
  const now = obj.state.ts || Date.now();
  const n = toNumber(obj.state.val);
  if (isNaN(n)) return;

  const dt = lastGridTs ? Math.max(0.5, (now - lastGridTs) / 1000) : 1.0;
  lastGridTs = now;

  gridRaw = n;

  // Filter grid power for control (EMA)
  if (gridFilt === 0) gridFilt = n;
  gridFilt = GRID_ALPHA * n + (1 - GRID_ALPHA) * gridFilt;
  if (Math.abs(gridFilt) < GRID_ZERO_BAND_W) gridFilt = 0;

  updateSocGate();

  // ================== FALLBACK_SOC (THIS IS THE IMPORTANT CHANGE) ==================
  // Discharging is blocked, but we continue to feed EcoFlow display with *raw grid import*.
  if (!socGate) {
    mode = 'FALLBACK_SOC';
    u = 0;

    const displayVal = clamp(Math.max(0, gridRaw), U_MIN, U_MAX); // <-- raw import, not filtered
    maybeWrite(displayVal, false);

    lastUpdateTs = Date.now();
    updateDebugStates();
    return;
  }
  // ===============================================================================

  // Control error: positive means we import more than desired -> increase EcoFlow output
  let err = gridFilt - TARGET_IMPORT_W;
  if (Math.abs(err) <= DEADBAND_W) err = 0;

  // Integral-like step
  let du = KI_PER_SEC * dt * err;
  du = clamp(du, -MAX_STEP_W, MAX_STEP_W);

  // Output authority
  const hasOutput = (ecoOut > EF_OUTPUT_ON_W);
  const startAllowed = (u < START_KICK_U_W && err > START_KICK_ERR_W);

  if (du > 0 && !(hasOutput || startAllowed)) {
    mode = 'HOLD_NO_AUTHORITY';
    du = 0;
  } else {
    mode = hasOutput ? 'CONTROL_EF_OUTPUT' : (startAllowed ? 'CONTROL_START_KICK' : 'CONTROL');
  }

  // Anti-windup
  if (u <= U_MIN && du < 0) du = 0;
  if (u >= U_MAX && du > 0) du = 0;

  u = clamp(u + du, U_MIN, U_MAX);

  maybeWrite(u, false);

  lastUpdateTs = Date.now();
  updateDebugStates();

  // Optional: rate-limited strategy error if controller runs outside self-powered mode
  if (lastStrategyRaw && !lastStrategyRaw.includes('"operateSelfPoweredOpen":1')) {
    logStrategyErrorOnce('controller active while strategy != self-powered');
  }
});

// ------------------- Startup init -------------------
try {
  const stSoc = getState(SOC);
  if (stSoc && stSoc.val !== undefined && stSoc.val !== null) {
    const n = toNumber(stSoc.val);
    if (!isNaN(n)) soc = n;
  }

  const stRes = getState(SOC_RES);
  if (stRes && stRes.val !== undefined && stRes.val !== null) {
    const n = toNumber(stRes.val);
    if (!isNaN(n)) socRes = n;
  }

  const stE = getState(ECOFLOW_OUT_W);
  if (stE && stE.val !== undefined) {
    const n = toNumber(stE.val);
    if (!isNaN(n)) ecoOut = n;
  }

  const stB = getState(BMS_STATE);
  if (stB && stB.val !== undefined && stB.val !== null) {
    bms = String(stB.val);
  }

  const stS = getState(EF_STRATEGY);
  if (stS && stS.val !== undefined) {
    const v = stS.val;
    lastStrategyRaw = (typeof v === 'object') ? JSON.stringify(v) : String(v);

    const ok =
      (typeof v === 'object' && v && v.operateSelfPoweredOpen === 1) ||
      (typeof v === 'string' && v.includes('"operateSelfPoweredOpen":1'));

    if (!ok) logStrategyErrorOnce('startup: operateSelfPoweredOpen != 1');
  }

  const stG = getState(GRID_W);
  if (stG && stG.val !== undefined) {
    const n = toNumber(stG.val);
    if (!isNaN(n)) {
      gridRaw = n;
      gridFilt = n;
      if (Math.abs(gridFilt) < GRID_ZERO_BAND_W) gridFilt = 0;
      lastGridTs = stG.ts || Date.now();
    }
  }

  updateSocGate();

  // Initialize u near current import
  u = clamp(Math.max(0, gridFilt), U_MIN, U_MAX);

  mode = socGate ? 'CONTROL' : 'FALLBACK_SOC';

  // On startup: if fallback, feed raw import; otherwise send u
  if (!socGate) {
    const displayVal = clamp(Math.max(0, gridRaw), U_MIN, U_MAX);
    maybeWrite(displayVal, true);
  } else {
    maybeWrite(u, true);
  }

  lastUpdateTs = Date.now();
  updateDebugStates();
} catch (e) {
  // ignore
}
