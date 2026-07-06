#!/usr/bin/env node
/**
 * sync.mjs — Pulls weighing data from SisGado (Firebird) and writes JSON
 * snapshots to /public/data for the dashboards to consume.
 *
 * Run: npm run sync
 *
 * The DESCRIPCION fields of LOCAIS / REBANHOS / LOTES / RACAS encode
 * additional information in free text (proveedor, partidario, fecha,
 * tipo de trabajo). Parsers below extract that.
 */

import Firebird from 'node-firebird';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'data');
const OVERRIDES_PATH = join(__dirname, '..', 'src', 'data', 'overrides.json');

function loadOverrides() {
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'));
  } catch {
    return { compras: {}, ghost_animals: [], ventas_split: {} };
  }
}

const options = {
  host: '127.0.0.1',
  port: 3050,
  database: 'C:\\SisGado\\bd\\SISGADO.FDB',
  user: 'SYSDBA',
  password: 'masterkey',
  lowercase_keys: false,
  role: null,
  pageSize: 4096,
};

// ---------- parsers ----------------------------------------------------------

const PARTIDARIOS = {
  BB: 'Bruno Bocangel',
  DB: 'Diego Bocangel',
  MB: 'Moira Bocangel',
  MA: 'Moira Eguez Avila',
  FB: 'Fabio Bocangel',
};

const TIPOS_TRABAJO = {
  CTRL:   'Control de peso',
  VTA:    'Venta',
  VT:     'Venta',
  VNT:    'Venta',
  ING:    'Ingreso',
  DS:      'Sanitaria / Dosificación',
  DOSIS:   'Sanitaria / Dosificación',
  SANIDAD: 'Sanitaria / Dosificación',
  SAN:     'Sanitaria / Dosificación',
  AUT:    'Autoconsumo',
  REFG:   'Refugo',
  REFUG:  'Refugo',
};

const CATEGORIA_NORM = {
  VAQ: 'VQ', VAQ_: 'VQ', VAQUI: 'VQ', VAQUILLA: 'VQ', VAQUILLAS: 'VQ',
  TOR: 'TL', TORILLO: 'TL', TORILLOS: 'TL',
  TORO: 'TO', TOROS: 'TO',
  NV: 'NV', NOV: 'NV', NOVILHA: 'NV',
  TR: 'TR', TERNERO: 'TR',
  TA: 'TA', TERNERA: 'TA',
};

/** Parse "DD.MM.YY" or "DD.MM.YYYY" → ISO yyyy-mm-dd, or null */
function parseFechaCompacta(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (!m) return null;
  const [, d, mo, yRaw] = m;
  const yy = yRaw.length === 2 ? (parseInt(yRaw, 10) > 50 ? '19' + yRaw : '20' + yRaw) : yRaw;
  return `${yy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Parse "BS5,316" "5,316 BS" "4.500BS" "4300 BS" → number (Bs) */
function parsePrecio(s) {
  if (!s) return null;
  // Match digits with optional commas/dots near "BS"
  const m = String(s).match(/(?:BS\s*)?([\d.,]{2,})\s*BS|BS\s*([\d.,]{2,})/i);
  if (!m) return null;
  const raw = (m[1] || m[2] || '').replace(/[.,]/g, '');
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Find the first 1-3 digit number that's likely a head count (cantidad) */
function parseCantidad(s, excludeYear = null) {
  if (!s) return null;
  const tokens = String(s).split(/\s+/);
  for (const t of tokens) {
    const m = t.match(/^(\d{1,4})$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 5000 && n !== excludeYear) return n;
    }
  }
  return null;
}

/** Detect categoria from any token in a string */
function parseCategoria(s) {
  if (!s) return null;
  const upper = String(s).toUpperCase();
  for (const [k, v] of Object.entries(CATEGORIA_NORM)) {
    const re = new RegExp(`\\b${k}\\b`);
    if (re.test(upper)) return v;
  }
  return null;
}

/**
 * LOCAIS.DESCRICAO → proveedor + cantidad + categoria + precio
 * Examples:
 *   "196 VAQ ROJAS MONT  BS5,316"        → 196, VQ, "ROJAS MONT", 5316
 *   "350 GUIT TOR MAR 4.500BS"           → 350, TL, "GUIT", 4500 (mes MAR)
 *   "120 NANCHI TOR ABR 5540BS"          → 120, TL, "NANCHI", 5540
 *   "FB | FABIO MAY 24"                  → fallback
 */
function parseLocal(desc) {
  if (!desc) return {};
  const out = { raw: desc };
  out.cantidad = parseCantidad(desc);
  out.categoria = parseCategoria(desc);
  out.precio_bs = parsePrecio(desc);

  // Strip cantidad, categoria tokens, precio, BS, mes → resto = proveedor
  const MES = /\b(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\b/i;
  let s = String(desc)
    .replace(/BS\s*[\d.,]+|[\d.,]+\s*BS/gi, '')
    .replace(/\b\d{2,4}\b/g, '')
    .replace(MES, '')
    .replace(/\b(VAQ|TOR|VAQUILLA|VAQUILLAS|TORILLO|TORILLOS|TORO|TOROS|VQ|TL|TO|NV|TR|TA)\b/gi, '')
    .replace(/[|·]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  out.proveedor = s || null;
  return out;
}

/**
 * REBANHOS.DESCRICAO → fecha + proveedor + categoria + cantidad
 * Examples:
 *   "06.11.25 CHIPA ROJAS VAQ"
 *   "28.10.25 WUAROYEL VQ 60"
 */
function parseRebanho(desc) {
  if (!desc) return {};
  const out = { raw: desc };
  out.fecha = parseFechaCompacta(desc);
  out.categoria = parseCategoria(desc);
  out.cantidad = parseCantidad(desc, out.fecha ? parseInt(out.fecha.split('-')[0], 10) : null);

  let s = String(desc)
    .replace(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/, '')
    .replace(/\b(VAQ|TOR|VAQUILLA|VAQUILLAS|TORILLO|TORILLOS|VQ|TL|TO|NV|TR|TA)\b/gi, '')
    .replace(/\b\d{1,4}\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  out.proveedor = s || null;
  return out;
}

/**
 * LOTES.DESCRICAO → fecha + tipo trabajo + detalle + precio Bs/kg (si es venta)
 * Examples:
 *   "05.05.26 VT TOR FRIG CALDAS"        → no precio
 *   "25.04.26 VTA INDU VAQ 21,5"         → 21.5 Bs/kg
 *   "09.03.25 VNT TOR INTERME 24BS"      → 24 Bs/kg
 *   "11.11.25 CTRL AUT 8"                → no precio (es ctrl)
 */
function parseLote(desc) {
  if (!desc) return {};
  const out = { raw: desc };
  out.fecha = parseFechaCompacta(desc);

  let resto = String(desc).replace(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/, '').trim();
  const tokens = resto.split(/\s+/);
  for (const t of tokens) {
    const upper = t.toUpperCase().replace(/[^A-Z]/g, '');
    if (TIPOS_TRABAJO[upper]) {
      out.tipo = upper;
      out.tipo_label = TIPOS_TRABAJO[upper];
      break;
    }
  }
  out.categoria = parseCategoria(resto);
  out.detalle = resto;

  // Bs/kg solo cuando es venta. Aceptamos formatos: 21,5  21.5  24  24BS
  // Filtramos rango razonable [10..50] para no agarrar cantidades.
  if (out.tipo === 'VT' || out.tipo === 'VTA' || out.tipo === 'VNT') {
    const matches = [...resto.matchAll(/\b(\d{1,2}(?:[,.]\d{1,2})?)\s*(?:BS)?\b/gi)];
    for (const m of matches) {
      const n = parseFloat(m[1].replace(',', '.'));
      if (n >= 10 && n <= 50) { out.precio_venta_bs_kg = n; break; }
    }
  }
  return out;
}

/**
 * RACAS.DESCRICAO → partidario (iniciales) + mes + categoria + cantidad
 * Examples:
 *   "BB MAR VAQ 27"     → BB, MAR, VQ, 27
 *   "FB NOVFEB VAQ 7"   → FB, NOVFEB, VQ, 7
 *   "DB NOV FEB VAQ 1"  → DB, NOV-FEB, VQ, 1
 */
function parseRaza(desc) {
  if (!desc) return {};
  const out = { raw: desc };
  const upper = String(desc).toUpperCase().trim();
  const tokens = upper.split(/\s+/);
  const inic = tokens[0];
  if (PARTIDARIOS[inic]) {
    out.partidario_id = inic;
    out.partidario = PARTIDARIOS[inic];
  }
  out.categoria = parseCategoria(upper);
  out.cantidad = parseCantidad(upper);
  // mes(es): tomar el chunk no-cantidad, no-categoria, no-inicial
  const meses = upper.match(/\b(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC|NOVFEB)\b/g);
  if (meses) out.mes = meses.join('-');
  return out;
}

// ---------- query ------------------------------------------------------------

const SQL = `
  SELECT
    a.ID_ANIMAL                  AS id_animal,
    a.COD_ANIMAL                 AS nro_interno,
    a.SEXO                       AS sexo,
    c.CODIGO                     AS cat_codigo,
    c.DESCRICAO                  AS cat_descripcion,
    r.CODIGO                     AS rebanho_codigo,
    r.DESCRICAO                  AS rebanho_descripcion,
    l.CODIGO                     AS lote_codigo,
    l.DESCRICAO                  AS lote_descripcion,
    lo.CODIGO                    AS local_codigo,
    lo.DESCRICAO                 AS local_descripcion,
    rc.CODIGO                    AS raza_codigo,
    rc.DESCRICAO                 AS raza_descripcion,
    od.CODIGO                    AS estancia_codigo,
    od.NOME                      AS estancia_nombre,
    p."DATA"                     AS pesaje_fecha,
    p.PESO                       AS pesaje_peso,
    s.DESCRICAO                  AS sesion_descripcion
  FROM ANIMAIS a
  LEFT JOIN PESAGENS p           ON a.ID_ANIMAL = p.FG_ID_ANIMAL
  LEFT JOIN CATEGORIAS c         ON a.FG_ID_CATEGORIA = c.ID_CATEGORIA
  LEFT JOIN REBANHOS r           ON a.FG_ID_REBANHO = r.ID_REBANHO
  LEFT JOIN LOTES l              ON a.FG_ID_LOTE = l.ID_LOTE
  LEFT JOIN LOCAIS lo            ON a.FG_ID_LOCAL = lo.ID_LOCAL
  LEFT JOIN RACAS rc             ON a.FG_ID_RACA = rc.ID_RACA
  LEFT JOIN SESSOES_TRABALHO s   ON p.FG_ID_SESSAO = s.ID_SESSAO
  LEFT JOIN ORIGEM_DESTINOS od   ON a.FG_ID_FAZENDA = od.ID_ORIGEM_DESTINO
  WHERE p.PESO IS NOT NULL
`;

function attach() {
  return new Promise((resolve, reject) => {
    Firebird.attach(options, (err, db) => err ? reject(err) : resolve(db));
  });
}
function query(db, sql) {
  return new Promise((resolve, reject) => {
    db.query(sql, [], (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// ---------- main -------------------------------------------------------------

async function main() {
  console.log('→ Connecting to Firebird (SISGADO.FDB)...');
  const db = await attach();
  console.log('→ Querying pesajes...');
  const rows = await query(db, SQL);
  console.log(`  ${rows.length.toLocaleString()} rows`);
  db.detach();

  console.log('→ Parsing descriptions...');
  let enriched = rows.map(r => {
    const local = parseLocal(r.LOCAL_DESCRIPCION);
    const rebanho = parseRebanho(r.REBANHO_DESCRIPCION);
    const lote = parseLote(r.LOTE_DESCRIPCION);
    const raza = parseRaza(r.RAZA_DESCRIPCION);
    const fecha = r.PESAJE_FECHA instanceof Date
      ? r.PESAJE_FECHA.toISOString().slice(0, 10)
      : (r.PESAJE_FECHA ? String(r.PESAJE_FECHA).slice(0, 10) : null);

    return {
      id_animal: r.ID_ANIMAL,
      nro: r.NRO_INTERNO != null ? String(r.NRO_INTERNO).trim() : null,
      sexo: r.SEXO,
      raza_codigo: r.RAZA_CODIGO != null ? String(r.RAZA_CODIGO).trim() : null,
      raza_descripcion: r.RAZA_DESCRIPCION,
      categoria: r.CAT_CODIGO,
      categoria_desc: r.CAT_DESCRIPCION,
      estancia: r.ESTANCIA_CODIGO,
      estancia_nombre: r.ESTANCIA_NOMBRE,
      fecha,
      peso: r.PESAJE_PESO != null ? Number(r.PESAJE_PESO) : null,
      sesion: r.SESION_DESCRIPCION,
      // proveedor (LOCAL)
      proveedor: local.proveedor,
      proveedor_categoria: local.categoria,
      proveedor_cantidad: local.cantidad,
      proveedor_precio_bs: local.precio_bs,
      proveedor_raw: local.raw,
      // ingreso (REBANHO)
      ingreso_fecha: rebanho.fecha,
      ingreso_proveedor: rebanho.proveedor,
      ingreso_cantidad: rebanho.cantidad,
      ingreso_raw: rebanho.raw,
      // trabajo de corral (LOTE)
      trabajo_fecha: lote.fecha,
      trabajo_tipo: lote.tipo,
      trabajo_tipo_label: lote.tipo_label,
      trabajo_detalle: lote.detalle,
      trabajo_precio_venta_bs_kg: lote.precio_venta_bs_kg ?? null,
      trabajo_raw: lote.raw,
      // partidario (RAZA)
      partidario_id: raza.partidario_id,
      partidario: raza.partidario,
      partidario_mes: raza.mes,
      partidario_cantidad: raza.cantidad,
      partidario_raw: raza.raw,
    };
  });

  // ---------- aggregations -------------------------------------------------
  console.log('→ Building aggregations...');

  // ---------- pesajes cutoff (chips reciclados) ----------
  // Algunos animales tienen pesajes anteriores de un dueño previo (cuando se
  // recicla el chip y SisGado no recibió baja). Filtramos por proveedor / raza / id.
  const overridesForCutoff = loadOverrides();
  const cutoffsByProv = overridesForCutoff.pesajes_cutoff?.por_proveedor || {};
  const cutoffsByRaca = overridesForCutoff.pesajes_cutoff?.por_raza_codigo || {};
  const cutoffsByAnim = overridesForCutoff.pesajes_cutoff?.por_animal_id || {};
  const hasAnyCutoff =
    Object.keys(cutoffsByProv).length > 0 ||
    Object.keys(cutoffsByRaca).length > 0 ||
    Object.keys(cutoffsByAnim).length > 0;

  if (hasAnyCutoff) {
    const before = enriched.length;
    enriched = enriched.filter(p => {
      if (!p.fecha) return true;
      // Por animal id (más específico)
      const idCut = cutoffsByAnim[String(p.id_animal)];
      if (idCut && p.fecha < idCut) return false;
      // Por raza
      const racaCut = p.raza_codigo ? cutoffsByRaca[p.raza_codigo] : null;
      if (racaCut && p.fecha < racaCut) return false;
      // Por proveedor (substring case-insensitive)
      if (p.proveedor) {
        const provUpper = p.proveedor.toUpperCase();
        for (const [pattern, cutoffDate] of Object.entries(cutoffsByProv)) {
          if (provUpper.includes(pattern.toUpperCase()) && p.fecha < cutoffDate) {
            return false;
          }
        }
      }
      return true;
    });
    const dropped = before - enriched.length;
    if (dropped > 0) console.log(`  ⚠ ${dropped} pesajes filtrados por cutoff (chips reciclados)`);
  }

  // Per-animal: first/last weighing, days, GMD, sale info if last was a sale
  const byAnimal = new Map();
  for (const p of enriched) {
    if (!p.fecha || p.peso == null) continue;
    let a = byAnimal.get(p.id_animal);
    if (!a) {
      a = {
        id_animal: p.id_animal,
        nro: p.nro,
        sexo: p.sexo,
        categoria: p.categoria,
        estancia: p.estancia,
        proveedor: p.proveedor,
        proveedor_precio_bs: p.proveedor_precio_bs,
        ingreso_fecha: p.ingreso_fecha,
        ingreso_proveedor: p.ingreso_proveedor,
        partidario_id: p.partidario_id,
        partidario: p.partidario,
        partidario_mes: p.partidario_mes,
        raza_codigo: p.raza_codigo,
        raza_descripcion: p.raza_descripcion,
        first_fecha: p.fecha,
        first_peso: p.peso,
        last_fecha: p.fecha,
        last_peso: p.peso,
        last_trabajo_tipo: p.trabajo_tipo,
        last_trabajo_precio_bs_kg: p.trabajo_precio_venta_bs_kg,
        last_sesion: p.sesion,
        n_pesajes: 1,
      };
      byAnimal.set(p.id_animal, a);
      continue;
    }
    a.n_pesajes++;
    if (p.fecha < a.first_fecha) { a.first_fecha = p.fecha; a.first_peso = p.peso; }
    if (p.fecha > a.last_fecha)  {
      a.last_fecha = p.fecha;
      a.last_peso = p.peso;
      a.last_trabajo_tipo = p.trabajo_tipo;
      a.last_trabajo_precio_bs_kg = p.trabajo_precio_venta_bs_kg;
      a.last_sesion = p.sesion;
    }
  }
  const overrides = loadOverrides();
  const bajas = overrides.animales_bajas || {};

  const SALIDAS = new Set(['VT', 'VTA', 'VNT', 'AUT', 'REFG', 'REFUG']);
  let animales = [...byAnimal.values()].map(a => {
    const dias = a.first_fecha && a.last_fecha
      ? Math.max(0, (new Date(a.last_fecha) - new Date(a.first_fecha)) / 86400000)
      : 0;
    const ganancia = a.last_peso - a.first_peso;
    const salida = SALIDAS.has(a.last_trabajo_tipo) ? a.last_trabajo_tipo : null;
    return {
      ...a,
      dias_en_campo: Math.round(dias),
      ganancia_kg: Math.round(ganancia * 10) / 10,
      gmd_kg: dias > 0 ? Math.round((ganancia / dias) * 1000) / 1000 : null,
      salida,                    // VT/VTA/VNT/AUT/REFG si ya salió, null si está activo
      vendido: salida === 'VT' || salida === 'VTA' || salida === 'VNT',
      ghost: false,
    };
  });

  // Aplicar reasignación de partidario por chip (animal_partidario_overrides).
  // Útil cuando se cae el chip y se identifica por número de paleta.
  // SisGado a veces tiene el mismo chip con prefijos (A) y (B) — ambos quedan asignados.
  const partOverrides = overrides.animal_partidario_overrides || {};
  const normalizeChip = (s) => String(s).replace(/[^0-9]/g, '');
  let nReasignados = 0;
  let noEncontrados = [];
  for (const [nro, pid] of Object.entries(partOverrides)) {
    if (nro.startsWith('_')) continue; // skip _doc
    const nroDigits = normalizeChip(nro);
    // Match si los dígitos del nro buscado terminan igual que los del animal,
    // o viceversa (uno puede tener más prefijo país que el otro)
    const targets = animales.filter(a => {
      if (!a.nro) return false;
      const aDigits = normalizeChip(a.nro);
      if (!aDigits) return false;
      return nroDigits.endsWith(aDigits) || aDigits.endsWith(nroDigits);
    });
    if (targets.length === 0) {
      noEncontrados.push(nro);
      continue;
    }
    for (const t of targets) {
      t.partidario_id = pid;
      t.partidario = PARTIDARIOS[pid] || pid;
      t.partidario_override = true;
      nReasignados++;
    }
  }
  if (nReasignados > 0) console.log(`  ${nReasignados} animales reasignados a partidario por chip`);
  if (noEncontrados.length > 0) console.log(`  ⚠ chips no encontrados en SisGado: ${noEncontrados.join(', ')}`);

  // Aplicar mapping de LOCAL a proveedor (local_proveedor_mapping).
  // Consolida nombres confusos hacia proveedores limpios. NO toca partidario.
  const localProvMap = overrides.local_proveedor_mapping || {};
  let nLocalMapped = 0;
  for (const a of animales) {
    if (!a.proveedor) continue;
    const upper = a.proveedor.toUpperCase();
    for (const [pattern, newProv] of Object.entries(localProvMap)) {
      if (pattern.startsWith('_')) continue;
      if (upper.includes(pattern.toUpperCase())) {
        a.proveedor = newProv;
        a.local_mapped = true;
        nLocalMapped++;
        break;
      }
    }
  }
  if (nLocalMapped > 0) console.log(`  ${nLocalMapped} proveedores consolidados por LOCAL mapping`);

  // Aplicar reasignación de origen por sesión (sesion_origen_reasignacion).
  // Cambia proveedores existentes por otros. Format:
  //   { "sesion_desc": { "PROVEEDOR_ORIGINAL": "PROVEEDOR_NUEVO", ... } }
  const sesionOrigReasig = overrides.sesion_origen_reasignacion || {};
  let nReasignados_orig = 0;
  for (const [sesion, mapping] of Object.entries(sesionOrigReasig)) {
    if (sesion.startsWith('_') || typeof mapping !== 'object') continue;
    for (const a of animales) {
      if (a.last_sesion !== sesion || !a.proveedor) continue;
      const upper = a.proveedor.toUpperCase();
      for (const [orig, nuevo] of Object.entries(mapping)) {
        if (orig.startsWith('_')) continue;
        if (upper.includes(orig.toUpperCase())) {
          a.proveedor = nuevo;
          a.proveedor_reasignado = true;
          nReasignados_orig++;
          break;
        }
      }
    }
  }
  if (nReasignados_orig > 0) console.log(`  ${nReasignados_orig} orígenes reasignados`);

  // Aplicar reasignación de animales existentes (sesion_animal_reasignacion).
  // Toma N animales sin partidario y sin origen de una sesión y les asigna
  // partidario_id y proveedor. NO crea animales nuevos.
  const sesionAnimalReasig = overrides.sesion_animal_reasignacion || {};
  let nAnimalReasig = 0;
  for (const [sesion, entries] of Object.entries(sesionAnimalReasig)) {
    if (sesion.startsWith('_') || !Array.isArray(entries)) continue;
    // Candidatos: sin partidario y sin origen, en la sesión
    let candidatos = animales
      .filter(a => a.last_sesion === sesion && !a.partidario_id && !a.proveedor)
      .sort((a, b) => a.id_animal - b.id_animal);
    for (const entry of entries) {
      const n = entry.cantidad || 0;
      const pid = entry.partidario_id;
      const prov = entry.proveedor;
      if (!pid || !prov || n <= 0) continue;
      const chunk = candidatos.slice(0, n);
      for (const a of chunk) {
        a.partidario_id = pid;
        a.partidario = PARTIDARIOS[pid] || pid;
        a.proveedor = prov;
        a.partidario_reasignado = true;
        nAnimalReasig++;
      }
      candidatos = candidatos.slice(n);
    }
  }
  if (nAnimalReasig > 0) console.log(`  ${nAnimalReasig} animales reasignados a partidario+proveedor de sesión`);

  // Aplicar fallback de origen por sesión (sesion_origen_fallback).
  // Format A: array de proveedores (round-robin equal)
  //   { "sesion_desc": ["PROV1", "PROV2", ...] }
  // Format B: objeto con cantidad exacta por proveedor
  //   { "sesion_desc": { "PROV1": 15, "PROV2": 10, ... } }
  const sesionOrigFallback = overrides.sesion_origen_fallback || {};
  let nOrigFallback = 0;
  for (const [sesion, config] of Object.entries(sesionOrigFallback)) {
    if (sesion.startsWith('_')) continue;
    const sinOrig = animales
      .filter(a => !a.proveedor && a.last_sesion === sesion)
      .sort((a, b) => a.id_animal - b.id_animal);
    if (sinOrig.length === 0) continue;

    if (Array.isArray(config)) {
      // Round-robin equal
      if (config.length === 0) continue;
      sinOrig.forEach((a, i) => {
        a.proveedor = config[i % config.length];
        a.proveedor_fallback = true;
        nOrigFallback++;
      });
    } else if (typeof config === 'object') {
      // Cantidades exactas
      const queue = [];
      for (const [prov, count] of Object.entries(config)) {
        if (prov.startsWith('_')) continue;
        for (let i = 0; i < count; i++) queue.push(prov);
      }
      const provs = Object.keys(config).filter(k => !k.startsWith('_'));
      sinOrig.forEach((a, i) => {
        a.proveedor = queue[i] || provs[i % provs.length];
        a.proveedor_fallback = true;
        nOrigFallback++;
      });
    }
    const dist = {};
    sinOrig.forEach(a => dist[a.proveedor] = (dist[a.proveedor] || 0) + 1);
    console.log(`  ${sinOrig.length} animales en ${sesion} → ${Object.entries(dist).map(([k,v]) => k+':'+v).join(', ')}`);
  }
  if (nOrigFallback > 0) console.log(`  ${nOrigFallback} origenes asignados por fallback`);

  // Post-procesamiento: para animales con proveedor pero sin fecha_ingreso o
  // sin proveedor_precio_bs, copiar de un template con el mismo proveedor.
  // Cubre casos donde asignamos proveedor via fallback/reasignacion/mapping.
  const templateByProv = new Map();
  const partialByProv = new Map();
  for (const a of animales) {
    if (!a.proveedor) continue;
    const hasFecha = !!a.ingreso_fecha;
    const hasPrecio = !!a.proveedor_precio_bs;
    if (!hasFecha && !hasPrecio) continue;
    // Preferir templates COMPLETOS (con fecha Y precio)
    if (hasFecha && hasPrecio) {
      if (!templateByProv.has(a.proveedor)) templateByProv.set(a.proveedor, a);
    } else {
      if (!partialByProv.has(a.proveedor)) partialByProv.set(a.proveedor, a);
    }
  }
  // Fallback: si no hay template completo, usar el parcial
  for (const [prov, a] of partialByProv) {
    if (!templateByProv.has(prov)) templateByProv.set(prov, a);
  }
  let nHydrated = 0;
  for (const a of animales) {
    if (!a.proveedor) continue;
    if (a.ingreso_fecha && a.proveedor_precio_bs) continue;
    const tpl = templateByProv.get(a.proveedor);
    if (!tpl) continue;
    if (!a.ingreso_fecha && tpl.ingreso_fecha) { a.ingreso_fecha = tpl.ingreso_fecha; nHydrated++; }
    if (!a.proveedor_precio_bs && tpl.proveedor_precio_bs) { a.proveedor_precio_bs = tpl.proveedor_precio_bs; }
  }
  if (nHydrated > 0) console.log(`  ${nHydrated} animales completados con fecha/precio del template del proveedor`);

  // Aplicar bajas (animales_bajas en overrides). Key = nro (chip)
  const bajaByNro = {};
  for (const [nro, info] of Object.entries(bajas)) {
    bajaByNro[String(nro).trim()] = info;
  }
  let nBajas = 0;
  for (const a of animales) {
    const baja = a.nro ? bajaByNro[String(a.nro).trim()] : null;
    if (baja) {
      a.baja = true;
      a.baja_fecha = baja.fecha || null;
      a.baja_tipo = baja.tipo || 'muerte';
      a.baja_nota = baja.nota || null;
      a.salida = a.salida || 'BAJA';
      a.vendido = false; // baja no es vendido
      nBajas++;
    }
  }
  if (nBajas > 0) console.log(`  ${nBajas} animales marcados como baja`);

  // ---------- ghost animals (chips caídos) ----------
  // Se inyectan al stream de animales con peso resuelto. Si peso === "promedio",
  // se calcula el promedio del partidario+categoria.
  const ghostList = overrides.ghost_animals || [];
  if (ghostList.length > 0) {
    // Helper: promedio con fallback en cascada
    function promedio(partidario_id, categoria, field, sesion = null) {
      // 1) Mejor fuente: animales del mismo partidario en la sesión específica
      if (sesion) {
        const ms = animales.filter(a => a.partidario_id === partidario_id && a.last_sesion === sesion);
        if (ms.length > 0) {
          return Math.round((ms.reduce((s, a) => s + (a[field] || 0), 0) / ms.length) * 10) / 10;
        }
        // 2) Si no hay partidarios en la sesión, usar promedio de TODA la sesión
        // (representa mejor la venta actual que un promedio general del partidario)
        const sesionAnimals = animales.filter(a => a.last_sesion === sesion);
        if (sesionAnimals.length > 0) {
          return Math.round((sesionAnimals.reduce((s, a) => s + (a[field] || 0), 0) / sesionAnimals.length) * 10) / 10;
        }
      }
      // 3) Por partidario general
      const ms = animales.filter(a => a.partidario_id === partidario_id);
      if (ms.length === 0) return 0;
      return Math.round((ms.reduce((s, a) => s + (a[field] || 0), 0) / ms.length) * 10) / 10;
    }

    // Template: si está vendido en sesion, copiamos de un animal de esa sesion (mismo proveedor)
    // Si no, copiamos de cualquier animal del partidario
    function findTemplate(partidario_id, sesion = null) {
      if (sesion) {
        const t = animales.find(a => a.partidario_id === partidario_id && a.last_sesion === sesion);
        if (t) return t;
      }
      return animales.find(a => a.partidario_id === partidario_id);
    }

    let nextGhostId = -1;

    // Función inline para crear un ghost (reusada para explícitos y auto-generados)
    function makeGhost(g) {
      const cat = g.categoria || null;
      const pid = g.partidario_id;
      const partidario_nombre = PARTIDARIOS[pid] || pid;
      const sesion = g.vendido_en_sesion || null;
      const tpl = findTemplate(pid, sesion);

      let firstP = g.first_peso ?? g.peso;
      let lastP  = g.last_peso  ?? g.peso;
      if (firstP === 'promedio' || firstP == null) firstP = promedio(pid, cat, 'first_peso', sesion);
      if (lastP  === 'promedio' || lastP  == null) lastP  = promedio(pid, cat, 'last_peso',  sesion);

      let dias = g.dias_en_campo;
      if (dias == null) {
        // Cascada: sesion avg → template → 0
        dias = promedio(pid, cat, 'dias_en_campo', sesion);
        if (!dias || dias === 0) dias = tpl?.dias_en_campo ?? 0;
      }
      dias = Math.round(dias);
      const ganancia = Math.round((lastP - firstP) * 10) / 10;
      const gmd = dias > 0 ? Math.round((ganancia / dias) * 1000) / 1000 : null;

      return {
        id_animal: nextGhostId--,
        nro: g.id || g.nro || `${pid}-G${Math.abs(nextGhostId + 1)}`,
        sexo: g.sexo || tpl?.sexo || null,
        categoria: cat,
        estancia: g.estancia || tpl?.estancia || 'LFA',
        proveedor: g.proveedor || tpl?.proveedor || null,
        proveedor_precio_bs: g.proveedor_precio_bs || tpl?.proveedor_precio_bs || null,
        ingreso_fecha: g.ingreso_fecha || tpl?.ingreso_fecha || null,
        ingreso_proveedor: g.ingreso_proveedor || tpl?.ingreso_proveedor || null,
        partidario_id: pid,
        partidario: partidario_nombre,
        partidario_mes: g.partidario_mes || tpl?.partidario_mes || null,
        raza_codigo: g.raza_codigo || tpl?.raza_codigo || pid,
        raza_descripcion: g.raza_descripcion || tpl?.raza_descripcion || null,
        first_fecha: g.first_fecha || tpl?.first_fecha || null,
        first_peso: firstP,
        last_fecha: g.last_fecha || tpl?.last_fecha || null,
        last_peso: lastP,
        last_trabajo_tipo: sesion ? 'VT' : (tpl?.last_trabajo_tipo || null),
        last_trabajo_precio_bs_kg: tpl?.last_trabajo_precio_bs_kg ?? null,
        last_sesion: sesion,
        n_pesajes: 1,
        dias_en_campo: dias,
        ganancia_kg: ganancia,
        gmd_kg: gmd,
        salida: sesion ? 'VT' : null,
        vendido: !!sesion,
        ghost: true,
        ghost_nota: g.nota || null,
      };
    }

    for (const g of ghostList) {
      animales.push(makeGhost(g));
    }
    console.log(`  +${ghostList.length} ghost animals explícitos inyectados`);

    // Auto-generación: completar hasta el target TOTAL por partidario.
    // El total del partidario va a coincidir con la suma de cat targets;
    // la distribución vq/tl se asigna priorizando déficit por categoría.
    const targets = overrides.partidario_total_targets || {};
    function inferCat(a) {
      if (a.ghost) return a.categoria || 'VQ';
      const raza = String(a.raza_descripcion || '').toUpperCase();
      if (/\bTOR(?!\w)|TORILLO/.test(raza)) return 'TL';
      return 'VQ';
    }
    let autoCount = 0;
    for (const [pid, catTargets] of Object.entries(targets)) {
      const totalTarget = Object.values(catTargets).reduce((s, n) => s + (n || 0), 0);
      const partAnimals = animales.filter(a => a.partidario_id === pid);
      const totalCurrent = partAnimals.length;
      const needed = totalTarget - totalCurrent;
      if (needed <= 0) {
        if (needed < 0) console.log(`  ⚠ ${pid} tiene ${totalCurrent} (target ${totalTarget}, ${-needed} de más)`);
        continue;
      }
      // Por cat: deficit = max(0, target - current)
      const currentByCat = {};
      for (const a of partAnimals) {
        const c = inferCat(a);
        currentByCat[c] = (currentByCat[c] || 0) + 1;
      }
      const deficits = {};
      for (const [cat, t] of Object.entries(catTargets)) {
        deficits[cat] = Math.max(0, (t || 0) - (currentByCat[cat] || 0));
      }
      let remaining = needed;
      for (const [cat, deficit] of Object.entries(deficits)) {
        const toAdd = Math.min(deficit, remaining);
        for (let i = 0; i < toAdd; i++) {
          animales.push(makeGhost({
            id: `${pid}-${cat}-A${i+1}`,
            partidario_id: pid,
            categoria: cat,
            peso: 'promedio',
            nota: `auto-generado (target ${pid} total ${totalTarget})`,
          }));
          autoCount++;
        }
        remaining -= toAdd;
      }
      // Default leftover a VQ
      for (let i = 0; i < remaining; i++) {
        animales.push(makeGhost({
          id: `${pid}-EXTRA-A${i+1}`,
          partidario_id: pid,
          categoria: 'VQ',
          peso: 'promedio',
          nota: `auto-generado (default VQ)`,
        }));
        autoCount++;
      }
      console.log(`  ${pid}: total ${totalCurrent} → ${totalTarget} (+${needed} ghosts)`);
    }
    if (autoCount > 0) console.log(`  +${autoCount} ghost animals auto-generados`);
  }

  // Sessions (corral jobs)
  const bySesion = new Map();
  for (const p of enriched) {
    if (!p.sesion) continue;
    let s = bySesion.get(p.sesion);
    if (!s) {
      s = {
        sesion: p.sesion,
        trabajo_tipo: p.trabajo_tipo,
        trabajo_tipo_label: p.trabajo_tipo_label,
        trabajo_fecha: p.trabajo_fecha,
        trabajo_detalle: p.trabajo_detalle,
        precio_venta_bs_kg: p.trabajo_precio_venta_bs_kg,
        fecha_min: p.fecha,
        fecha_max: p.fecha,
        n: 0,
        peso_sum: 0,
        peso_min: Infinity,
        peso_max: -Infinity,
      };
      bySesion.set(p.sesion, s);
    }
    if (p.peso != null) {
      s.n++;
      s.peso_sum += p.peso;
      if (p.peso < s.peso_min) s.peso_min = p.peso;
      if (p.peso > s.peso_max) s.peso_max = p.peso;
    }
    if (p.fecha) {
      if (!s.fecha_min || p.fecha < s.fecha_min) s.fecha_min = p.fecha;
      if (!s.fecha_max || p.fecha > s.fecha_max) s.fecha_max = p.fecha;
    }
  }
  const sesiones = [...bySesion.values()]
    .map(s => ({
      ...s,
      peso_prom: s.n > 0 ? Math.round((s.peso_sum / s.n) * 10) / 10 : null,
      peso_min: s.peso_min === Infinity ? null : s.peso_min,
      peso_max: s.peso_max === -Infinity ? null : s.peso_max,
    }))
    .sort((a, b) => (b.fecha_max || '').localeCompare(a.fecha_max || ''));

  // Per-sesion breakdowns: for sales/exits, group animals (by last sesion) by partidario, proveedor, categoria
  const animalesByLastSesion = new Map();
  for (const a of animales) {
    if (!a.last_sesion) continue;
    let arr = animalesByLastSesion.get(a.last_sesion);
    if (!arr) { arr = []; animalesByLastSesion.set(a.last_sesion, arr); }
    arr.push(a);
  }

  // Reemplazar s.n (pesajes) por count de animales únicos cuya last_sesion = esta.
  // Y recalcular peso_prom sobre los unique animals.
  for (const s of sesiones) {
    const ans = animalesByLastSesion.get(s.sesion) || [];
    if (ans.length > 0) {
      s.n = ans.length;
      const pesos = ans.map(a => a.last_peso).filter(p => p != null);
      if (pesos.length > 0) {
        s.peso_sum = pesos.reduce((x, y) => x + y, 0);
        s.peso_prom = Math.round((s.peso_sum / pesos.length) * 10) / 10;
        s.peso_min = Math.min(...pesos);
        s.peso_max = Math.max(...pesos);
      }
    }
  }
  function group(animals, keyFn, labelFn) {
    const m = new Map();
    for (const a of animals) {
      const k = keyFn(a);
      if (k == null) continue;
      let g = m.get(k);
      if (!g) {
        g = {
          key: String(k), label: labelFn ? labelFn(a) : String(k),
          cabezas: 0, peso_bruto_sum: 0, peso_in_sum: 0, ganancia_sum: 0,
          dias_sum: 0, gmd_sum: 0, gmd_n: 0,
          precio_sum: 0, precio_n: 0,
          ingreso_fecha_min: null, ingreso_fecha_max: null,
          last_fecha_min: null, last_fecha_max: null,
          origenes: new Set(),
        };
        m.set(k, g);
      }
      g.cabezas++;
      g.peso_bruto_sum += a.last_peso;
      g.peso_in_sum += a.first_peso;
      g.ganancia_sum += a.ganancia_kg;
      g.dias_sum += a.dias_en_campo;
      if (a.gmd_kg != null) { g.gmd_sum += a.gmd_kg; g.gmd_n++; }
      if (a.proveedor_precio_bs != null) { g.precio_sum += a.proveedor_precio_bs; g.precio_n++; }
      if (a.ingreso_fecha) {
        if (!g.ingreso_fecha_min || a.ingreso_fecha < g.ingreso_fecha_min) g.ingreso_fecha_min = a.ingreso_fecha;
        if (!g.ingreso_fecha_max || a.ingreso_fecha > g.ingreso_fecha_max) g.ingreso_fecha_max = a.ingreso_fecha;
      }
      if (a.last_fecha) {
        if (!g.last_fecha_min || a.last_fecha < g.last_fecha_min) g.last_fecha_min = a.last_fecha;
        if (!g.last_fecha_max || a.last_fecha > g.last_fecha_max) g.last_fecha_max = a.last_fecha;
      }
      if (a.proveedor) g.origenes.add(a.proveedor);
    }
    return [...m.values()].map(g => ({
      key: g.key,
      label: g.label,
      cabezas: g.cabezas,
      peso_prom: Math.round((g.peso_bruto_sum / g.cabezas) * 10) / 10,
      peso_neto_total: Math.round(g.peso_bruto_sum * 0.95),
      peso_neto_prom: Math.round((g.peso_bruto_sum / g.cabezas) * 0.95 * 10) / 10,
      peso_bruto_total: Math.round(g.peso_bruto_sum),
      peso_ingreso_prom: Math.round((g.peso_in_sum / g.cabezas) * 10) / 10,
      ganancia_kg_prom: Math.round((g.ganancia_sum / g.cabezas) * 10) / 10,
      gmd_prom: g.gmd_n > 0 ? Math.round((g.gmd_sum / g.gmd_n) * 1000) / 1000 : null,
      dias_prom: g.cabezas > 0 ? Math.round(g.dias_sum / g.cabezas) : 0,
      precio_compra_bs_prom: g.precio_n > 0 ? Math.round(g.precio_sum / g.precio_n) : null,
      ingreso_fecha_min: g.ingreso_fecha_min,
      last_fecha_max: g.last_fecha_max,
      origenes: [...g.origenes],
    })).sort((a, b) => b.cabezas - a.cabezas);
  }
  // Convertir destinos del override a destinos calculados.
  // Modo "explícito": se usan los valores hardcoded de cabezas/peso/bs_kg.
  // No se intenta asignar animales individuales a un comprador específico.
  function buildDestinos(destinos) {
    return destinos.map(d => {
      const cab = d.cabezas || 0;
      const pesoBruto = d.peso_bruto_prom || 0;
      const pesoNeto  = d.peso_neto_prom != null ? d.peso_neto_prom : Math.round(pesoBruto * 0.95);
      const peso_total_bruto = Math.round(cab * pesoBruto);
      const peso_total_neto  = Math.round(cab * pesoNeto);
      const ingreso_bs = Math.round(peso_total_neto * (d.bs_kg || 0));
      return {
        comprador: d.comprador,
        cabezas: cab,
        peso_prom_bruto: pesoBruto,
        peso_prom_neto:  pesoNeto,
        peso_total_bruto,
        peso_total_neto,
        bs_kg: d.bs_kg ?? null,
        fecha: d.fecha || null,
        ingreso_bs,
      };
    });
  }

  const ventasSplit = overrides.ventas_split || {};
  const priceOverrides = overrides.sesion_price_overrides || {};
  for (const s of sesiones) {
    if (priceOverrides[s.sesion] != null) {
      s.precio_venta_bs_kg = priceOverrides[s.sesion];
    }
    const animals = animalesByLastSesion.get(s.sesion) || [];
    s.por_partidario = group(animals, a => a.partidario_id, a => a.partidario || a.partidario_id || '');
    s.por_proveedor  = group(animals, a => a.proveedor || null);
    s.por_categoria  = group(animals, a => a.categoria || null);
    s.por_raza       = group(animals, a => a.raza_codigo || a.raza_descripcion || null, a => a.raza_descripcion || a.raza_codigo || '');

    // splits por comprador (si hay override)
    const split = ventasSplit[s.sesion];
    if (split && split.destinos) {
      const destinos = buildDestinos(split.destinos);
      s.split = {
        nota: split.nota || null,
        destinos,
      };
      // Mapeo opcional partidario → destino: aplica bs_kg/fecha/comprador
      // específicos a cada partidario row (sobreescribe el avg ponderado).
      if (split.partidario_destino) {
        for (const row of s.por_partidario) {
          const compradorName = split.partidario_destino[row.key];
          if (!compradorName) continue;
          const dest = destinos.find(d => d.comprador === compradorName);
          if (!dest) continue;
          row.bs_kg = dest.bs_kg;
          row.fecha_venta = dest.fecha;
          row.comprador = dest.comprador;
        }
      } else if (destinos.length === 1) {
        // Si hay un solo comprador, todos los partidarios y proveedores van ahí
        const dest = destinos[0];
        for (const row of s.por_partidario) {
          row.bs_kg = dest.bs_kg;
          row.fecha_venta = dest.fecha;
          row.comprador = dest.comprador;
        }
        for (const row of s.por_proveedor) {
          row.bs_kg = dest.bs_kg;
          row.fecha_venta = dest.fecha;
          row.comprador = dest.comprador;
        }
      }
      // Override del header: cabezas, peso_prom, ingreso vienen del split
      const totalCab = destinos.reduce((x, d) => x + d.cabezas, 0);
      const totalBrutoKg = destinos.reduce((x, d) => x + d.peso_total_bruto, 0);
      const totalNetoKg  = destinos.reduce((x, d) => x + d.peso_total_neto, 0);
      const totalIngreso = destinos.reduce((x, d) => x + d.ingreso_bs, 0);
      s.n = totalCab;
      s.peso_prom = totalCab > 0 ? Math.round((totalBrutoKg / totalCab) * 10) / 10 : null;
      s.peso_neto_total = totalNetoKg;
      s.peso_bruto_total = totalBrutoKg;
      s.ingreso_bs_total = totalIngreso;
      s.precio_venta_bs_kg = null;
      // Promedio ponderado Bs/kg (sobre peso neto) — para calcular ingreso por partidario
      s.precio_avg_bs_kg = totalNetoKg > 0 ? Math.round((totalIngreso / totalNetoKg) * 100) / 100 : null;
    }

    s.slug = String(s.sesion).toLowerCase()
      .replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  // ---------- write --------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  const meta = {
    generated_at: new Date().toISOString(),
    n_pesajes: enriched.length,
    n_animales: animales.length,
    n_sesiones: sesiones.length,
  };
  writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(OUT_DIR, 'pesajes.json'), JSON.stringify(enriched));

  // Search index — lightweight para búsqueda client-side
  const searchIndex = animales.map(a => ({
    id: a.id_animal,
    nro: a.nro,
    p: a.partidario_id,
    pn: a.partidario,
    s: a.sexo,
    o: a.proveedor,
    lp: a.last_peso,
    lf: a.last_fecha,
    v: a.vendido ? 1 : 0,
    g: a.ghost ? 1 : 0,
  }));
  writeFileSync(join(OUT_DIR, 'search-index.json'), JSON.stringify(searchIndex));

  // pesajes-by-animal.json — formato compacto { id_animal: [[fecha,peso], ...] }
  const byAnimalPesajes = {};
  for (const p of enriched) {
    if (!p.fecha || p.peso == null) continue;
    (byAnimalPesajes[p.id_animal] ??= []).push([p.fecha, p.peso]);
  }
  for (const id in byAnimalPesajes) {
    byAnimalPesajes[id].sort((a, b) => a[0].localeCompare(b[0]));
  }
  writeFileSync(join(OUT_DIR, 'pesajes-by-animal.json'), JSON.stringify(byAnimalPesajes));
  writeFileSync(join(OUT_DIR, 'animales.json'), JSON.stringify(animales));
  writeFileSync(join(OUT_DIR, 'sesiones.json'), JSON.stringify(sesiones, null, 2));

  console.log('✓ Wrote:');
  console.log(`  meta.json       (${meta.n_pesajes} pesajes, ${meta.n_animales} animales, ${meta.n_sesiones} sesiones)`);
  console.log(`  pesajes.json`);
  console.log(`  animales.json`);
  console.log(`  sesiones.json`);
}

main().catch(err => {
  console.error('✗ sync failed:', err);
  process.exit(1);
});
