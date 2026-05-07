const path = require('path');

let duckdbStatus = { loaded: false, error: null, version: null };
let db = null;
let conn = null;

try {
  const duckdb = require('duckdb');
  db = new duckdb.Database(':memory:');
  conn = db.connect();
  duckdbStatus.loaded = true;
} catch (e) {
  duckdbStatus.error = String(e && e.stack || e);
}

function bigIntSafe(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(bigIntSafe);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = bigIntSafe(v[k]);
    return o;
  }
  return v;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!conn) return reject(new Error('duckdb not loaded: ' + duckdbStatus.error));
    const cb = (err, rows) => err ? reject(err) : resolve(bigIntSafe(rows));
    if (params.length) conn.all(sql, ...params, cb); else conn.all(sql, cb);
  });
}

run('SELECT version() AS v').then(r => { duckdbStatus.version = r[0].v; }).catch(() => {});

const esc = p => String(p).replace(/'/g, "''");
const ATTACH_EXTS = new Set(['.duckdb', '.db']);

const FORMATS = {
  '.csv':      { reader: p => `read_csv_auto('${esc(p)}')`, deps: [] },
  '.tsv':      { reader: p => `read_csv_auto('${esc(p)}', delim='\\t')`, deps: [] },
  '.parquet':  { reader: p => `read_parquet('${esc(p)}')`, deps: [] },
  '.xlsx':     { reader: p => `read_xlsx('${esc(p)}')`, deps: [{ name: 'excel' }] },
  '.xls':      { reader: p => `read_xlsx('${esc(p)}')`, deps: [{ name: 'excel' }] },
  '.dta':      { reader: p => `read_stat('${esc(p)}')`, deps: [{ name: 'read_stat', community: true }] },
  '.sav':      { reader: p => `read_stat('${esc(p)}')`, deps: [{ name: 'read_stat', community: true }] },
  '.por':      { reader: p => `read_stat('${esc(p)}')`, deps: [{ name: 'read_stat', community: true }] },
  '.sas7bdat': { reader: p => `read_stat('${esc(p)}')`, deps: [{ name: 'read_stat', community: true }] },
  '.xpt':      { reader: p => `read_stat('${esc(p)}')`, deps: [{ name: 'read_stat', community: true }] },
};

const extState = {};
const extError = {};
const extPromise = {};

function ensureExt(name, community = false) {
  if (extState[name] === 'ready') return Promise.resolve();
  if (extState[name] === 'failed') return Promise.reject(new Error(`extension "${name}" unavailable: ${extError[name]}`));
  if (extPromise[name]) return extPromise[name];
  extPromise[name] = (async () => {
    try {
      try { await run(`LOAD ${name}`); }
      catch {
        const from = community ? ' FROM community' : '';
        await run(`INSTALL ${name}${from}`);
        await run(`LOAD ${name}`);
      }
      extState[name] = 'ready';
    } catch (e) {
      extState[name] = 'failed';
      extError[name] = String(e.message || e);
      throw new Error(`failed to install/load extension "${name}": ${extError[name]}`);
    } finally { delete extPromise[name]; }
  })();
  return extPromise[name];
}

async function ensureDeps(deps) { for (const d of deps) await ensureExt(d.name, !!d.community); }

const attachAlias = new Map();
let attachCounter = 0;
async function ensureAttached(filePath) {
  if (attachAlias.has(filePath)) return attachAlias.get(filePath);
  const alias = `udb_${++attachCounter}`;
  await run(`ATTACH '${esc(filePath)}' AS ${alias} (READ_ONLY)`);
  attachAlias.set(filePath, alias);
  return alias;
}

// columns whose JS-side representation is awkward; cast to VARCHAR in DuckDB so
// it formats them naturally (DATE -> "2020-11-19", TIMESTAMP -> "2020-11-19 00:00:00", etc.)
const STRINGIFY_RE = /^(DATE|TIME|TIMESTAMP|INTERVAL|BLOB|UUID|HUGEINT|UHUGEINT|UBIGINT|BIGINT|DECIMAL)/i;

let viewSelect = 'SELECT *';

function buildViewSelect(columns) {
  const reps = [];
  for (const c of columns || []) {
    const t = String(c.column_type || c.type || '').toUpperCase();
    if (STRINGIFY_RE.test(t)) {
      const q = `"${String(c.column_name || c.name).replace(/"/g, '""')}"`;
      reps.push(`${q}::VARCHAR AS ${q}`);
    }
  }
  return reps.length ? `SELECT * REPLACE (${reps.join(', ')})` : 'SELECT *';
}

async function setSource(selectExpr) {
  await run(`CREATE OR REPLACE TEMP VIEW dv AS SELECT * FROM ${selectExpr}`);
  await run(`CREATE OR REPLACE TEMP VIEW dv_view AS SELECT * FROM dv`);
  const [cnt, cols] = await Promise.all([
    run('SELECT COUNT(*) AS n FROM dv_view').then(r => r[0].n).catch(() => null),
    run('DESCRIBE dv_view').catch(() => []),
  ]);
  viewSelect = buildViewSelect(cols);
  return { total: cnt, columns: cols };
}

window.dv = {
  status: () => ({ ...duckdbStatus, extensions: { ...extState } }),

  open: async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ATTACH_EXTS.has(ext)) {
      const alias = await ensureAttached(filePath);
      const tables = await run(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_catalog = '${esc(alias)}' ORDER BY table_schema, table_name`
      );
      return { kind: 'tables', alias, tables, filePath };
    }
    const fmt = FORMATS[ext];
    if (!fmt) throw new Error('unsupported extension: ' + ext);
    await ensureDeps(fmt.deps);
    const meta = await setSource(fmt.reader(filePath));
    return { kind: 'rows', filePath, ...meta };
  },

  openTable: async (filePath, schema, table) => {
    const alias = await ensureAttached(filePath);
    const ref = `${alias}."${String(schema).replace(/"/g,'""')}"."${String(table).replace(/"/g,'""')}"`;
    const meta = await setSource(ref);
    return { kind: 'rows', filePath, schema, table, ...meta };
  },

  page: async (offset, limit) => {
    return run(`${viewSelect} FROM dv_view LIMIT ${limit | 0} OFFSET ${offset | 0}`);
  },

  query: async (sql) => {
    const trimmed = String(sql).trim().replace(/;+\s*$/, '');
    await run(`CREATE OR REPLACE TEMP VIEW dv_view AS ${trimmed}`);
    const [cnt, cols] = await Promise.all([
      run('SELECT COUNT(*) AS n FROM dv_view').then(r => r[0].n).catch(() => null),
      run('DESCRIBE dv_view').catch(() => []),
    ]);
    viewSelect = buildViewSelect(cols);
    return { total: cnt, columns: cols };
  },

  rawQuery: async (sql) => run(sql),

  getSettings: () => {
    try { return window.utools.dbStorage.getItem('dataview.settings') || null; }
    catch { return null; }
  },
  setSettings: (s) => {
    try { window.utools.dbStorage.setItem('dataview.settings', s); return true; }
    catch { return false; }
  },
};
