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
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'data');

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
  FB: 'Fabio',
};

const TIPOS_TRABAJO = {
  CTRL:   'Control de peso',
  VTA:    'Venta',
  VT:     'Venta',
  VNT:    'Venta',
  ING:    'Ingreso',
  DS:     'Sanitaria / Dosificación',
  DOSIS:  'Sanitaria / Dosificación',
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
  const enriched = rows.map(r => {
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
  const SALIDAS = new Set(['VT', 'VTA', 'VNT', 'AUT', 'REFG', 'REFUG']);
  const animales = [...byAnimal.values()].map(a => {
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
    };
  });

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
