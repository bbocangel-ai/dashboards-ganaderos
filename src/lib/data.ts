/**
 * Data layer — runs at build time only. Aggregates the JSON snapshots
 * produced by `npm run sync` into the shapes each dashboard needs.
 */

import animalesRaw from '../../public/data/animales.json';
import sesionesRaw from '../../public/data/sesiones.json';
import metaRaw from '../../public/data/meta.json';
import pesajesByAnimalRaw from '../../public/data/pesajes-by-animal.json';
import overridesRaw from '../data/overrides.json';

export const pesajesByAnimal = pesajesByAnimalRaw as Record<string, [string, number][]>;

type Overrides = { compras: Record<string, { cabezas_real?: number; nota?: string }> };
export const overrides = (overridesRaw as unknown as Overrides);

export type Animal = {
  id_animal: number;
  nro: string | null;
  sexo: string | null;
  categoria: string | null;
  estancia: string | null;
  proveedor: string | null;
  proveedor_precio_bs: number | null;
  ingreso_fecha: string | null;
  ingreso_proveedor: string | null;
  partidario_id: string | null;
  partidario: string | null;
  partidario_mes: string | null;
  raza_codigo: string | null;
  raza_descripcion: string | null;
  first_fecha: string;
  first_peso: number;
  last_fecha: string;
  last_peso: number;
  n_pesajes: number;
  dias_en_campo: number;
  ganancia_kg: number;
  gmd_kg: number | null;
  salida: string | null;
  vendido: boolean;
  last_trabajo_tipo: string | null;
  last_trabajo_precio_bs_kg: number | null;
  last_sesion: string | null;
};

export type GroupRow = {
  key: string;
  label: string;
  cabezas: number;
  peso_prom: number;
  peso_neto_total: number;
  peso_ingreso_prom: number;
  ganancia_kg_prom: number;
  dias_prom: number;
};

export type Sesion = {
  sesion: string;
  slug: string;
  trabajo_tipo: string | null;
  trabajo_tipo_label: string | null;
  trabajo_fecha: string | null;
  trabajo_detalle: string | null;
  precio_venta_bs_kg: number | null;
  fecha_min: string | null;
  fecha_max: string | null;
  n: number;
  peso_prom: number | null;
  peso_min: number | null;
  peso_max: number | null;
  por_partidario: GroupRow[];
  por_proveedor: GroupRow[];
  por_categoria: GroupRow[];
  por_raza: GroupRow[];
};

export type Meta = {
  generated_at: string;
  n_pesajes: number;
  n_animales: number;
  n_sesiones: number;
};

export const animales = animalesRaw as Animal[];
export const sesiones = sesionesRaw as Sesion[];
export const meta = metaRaw as Meta;

// ---------- helpers ---------------------------------------------------------

export function fmtFecha(s: string | null | undefined) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

export function fmtNum(n: number | null | undefined, decimals = 0) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('es-BO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtBs(n: number | null | undefined) {
  if (n == null) return '—';
  return 'Bs ' + n.toLocaleString('es-BO');
}

// ---------- aggregations ---------------------------------------------------

export type ProveedorAgg = {
  proveedor: string;
  cabezas: number;
  precio_bs_prom: number | null;
  peso_ingreso_prom: number;
  peso_actual_prom: number;
  ganancia_kg_prom: number;
  gmd_prom: number | null;
  bs_kg_estimado: number | null;
  total_invertido_bs: number | null;
};

export function aggProveedores(): ProveedorAgg[] {
  const map = new Map<string, {
    cabezas: number; precio_sum: number; precio_n: number;
    peso_in_sum: number; peso_out_sum: number; ganancia_sum: number;
    gmd_sum: number; gmd_n: number;
  }>();

  for (const a of animales) {
    if (!a.proveedor) continue;
    const key = a.proveedor;
    let g = map.get(key);
    if (!g) {
      g = { cabezas: 0, precio_sum: 0, precio_n: 0, peso_in_sum: 0, peso_out_sum: 0, ganancia_sum: 0, gmd_sum: 0, gmd_n: 0 };
      map.set(key, g);
    }
    g.cabezas++;
    if (a.proveedor_precio_bs) { g.precio_sum += a.proveedor_precio_bs; g.precio_n++; }
    g.peso_in_sum += a.first_peso;
    g.peso_out_sum += a.last_peso;
    g.ganancia_sum += a.ganancia_kg;
    if (a.gmd_kg != null) { g.gmd_sum += a.gmd_kg; g.gmd_n++; }
  }

  const out: ProveedorAgg[] = [];
  for (const [proveedor, g] of map) {
    const precio_bs_prom = g.precio_n > 0 ? g.precio_sum / g.precio_n : null;
    const peso_in = g.peso_in_sum / g.cabezas;
    out.push({
      proveedor,
      cabezas: g.cabezas,
      precio_bs_prom: precio_bs_prom != null ? Math.round(precio_bs_prom) : null,
      peso_ingreso_prom: Math.round(peso_in * 10) / 10,
      peso_actual_prom: Math.round((g.peso_out_sum / g.cabezas) * 10) / 10,
      ganancia_kg_prom: Math.round((g.ganancia_sum / g.cabezas) * 10) / 10,
      gmd_prom: g.gmd_n > 0 ? Math.round((g.gmd_sum / g.gmd_n) * 1000) / 1000 : null,
      bs_kg_estimado: precio_bs_prom != null && peso_in > 0 ? Math.round((precio_bs_prom / peso_in) * 100) / 100 : null,
      total_invertido_bs: precio_bs_prom != null ? Math.round(precio_bs_prom * g.cabezas) : null,
    });
  }
  return out.sort((a, b) => b.cabezas - a.cabezas);
}

export type Compra = {
  raza_codigo: string;            // CODIGO en RACAS (key del override)
  raza_descripcion: string;
  partidario_id: string | null;
  partidario: string | null;
  mes: string | null;
  categoria: string | null;
  cabezas_sisgado: number;        // count real en SisGado
  cabezas_real: number | null;    // override manual
  cabezas_efectivas: number;      // real ?? sisgado
  override_nota: string | null;
  peso_ingreso_prom: number;
  peso_actual_prom: number;
  ganancia_kg_prom: number;
  gmd_prom: number | null;
  kg_totales_ganados: number;
  dias_prom: number;
  origenes: string[];
  precio_compra_bs_prom: number | null;
  ingreso_fecha_min: string | null;
  vendidos: number;
  activos: number;
};

export type PartidarioAgg = {
  id: string;
  nombre: string;
  compras: Compra[];
  cabezas_sisgado: number;
  cabezas_efectivas: number;
  por_categoria: Record<string, number>;
  peso_ingreso_prom: number;
  peso_actual_prom: number;
  ganancia_kg_prom: number;
  gmd_prom: number | null;
  kg_totales_ganados: number;
  origenes: string[];
  precio_compra_bs_prom: number | null;
  ingreso_fecha_min: string | null;
  dias_prom: number;
};

export function aggCompras(): Compra[] {
  const map = new Map<string, {
    raza_codigo: string;
    raza_descripcion: string;
    partidario_id: string | null;
    partidario: string | null;
    mes: string | null;
    categoria: string | null;
    cabezas: number;
    peso_in_sum: number; peso_out_sum: number; gan_sum: number;
    gmd_sum: number; gmd_n: number;
    dias_sum: number; dias_n: number;
    origenes: Set<string>;
    precio_sum: number; precio_n: number;
    ingreso_fecha_min: string | null;
    vendidos: number;
  }>();

  for (const a of animales) {
    if (!a.partidario_id) continue;          // solo animales partidarios
    const key = a.raza_codigo || a.raza_descripcion || a.partidario_id;
    let g = map.get(key);
    if (!g) {
      g = {
        raza_codigo: a.raza_codigo || key,
        raza_descripcion: a.raza_descripcion || a.partidario_id,
        partidario_id: a.partidario_id,
        partidario: a.partidario,
        mes: a.partidario_mes,
        categoria: a.categoria,
        cabezas: 0,
        peso_in_sum: 0, peso_out_sum: 0, gan_sum: 0, gmd_sum: 0, gmd_n: 0,
        dias_sum: 0, dias_n: 0,
        origenes: new Set(),
        precio_sum: 0, precio_n: 0,
        ingreso_fecha_min: null,
        vendidos: 0,
      };
      map.set(key, g);
    }
    g.cabezas++;
    g.peso_in_sum += a.first_peso;
    g.peso_out_sum += a.last_peso;
    g.gan_sum += a.ganancia_kg;
    if (a.gmd_kg != null) { g.gmd_sum += a.gmd_kg; g.gmd_n++; }
    if (a.dias_en_campo > 0) { g.dias_sum += a.dias_en_campo; g.dias_n++; }
    if (a.proveedor) g.origenes.add(a.proveedor);
    if (a.proveedor_precio_bs != null) { g.precio_sum += a.proveedor_precio_bs; g.precio_n++; }
    if (a.ingreso_fecha) {
      if (!g.ingreso_fecha_min || a.ingreso_fecha < g.ingreso_fecha_min) g.ingreso_fecha_min = a.ingreso_fecha;
    }
    if (a.vendido) g.vendidos++;
  }

  const out: Compra[] = [];
  for (const [, g] of map) {
    const ov = overrides.compras?.[g.raza_codigo];
    const real = ov?.cabezas_real ?? null;
    out.push({
      raza_codigo: g.raza_codigo,
      raza_descripcion: g.raza_descripcion,
      partidario_id: g.partidario_id,
      partidario: g.partidario,
      mes: g.mes,
      categoria: g.categoria,
      cabezas_sisgado: g.cabezas,
      cabezas_real: real,
      cabezas_efectivas: real ?? g.cabezas,
      override_nota: ov?.nota ?? null,
      peso_ingreso_prom: Math.round((g.peso_in_sum / g.cabezas) * 10) / 10,
      peso_actual_prom: Math.round((g.peso_out_sum / g.cabezas) * 10) / 10,
      ganancia_kg_prom: Math.round((g.gan_sum / g.cabezas) * 10) / 10,
      gmd_prom: g.gmd_n > 0 ? Math.round((g.gmd_sum / g.gmd_n) * 1000) / 1000 : null,
      kg_totales_ganados: Math.round(g.gan_sum),
      dias_prom: g.dias_n > 0 ? Math.round(g.dias_sum / g.dias_n) : 0,
      origenes: [...g.origenes],
      precio_compra_bs_prom: g.precio_n > 0 ? Math.round(g.precio_sum / g.precio_n) : null,
      ingreso_fecha_min: g.ingreso_fecha_min,
      vendidos: g.vendidos,
      activos: g.cabezas - g.vendidos,
    });
  }
  return out.sort((a, b) => {
    const p = (a.partidario_id || '').localeCompare(b.partidario_id || '');
    if (p !== 0) return p;
    return (b.ingreso_fecha_min || '').localeCompare(a.ingreso_fecha_min || '');
  });
}

export function aggPartidarios(): PartidarioAgg[] {
  const compras = aggCompras();
  const byPart = new Map<string, Compra[]>();
  for (const c of compras) {
    if (!c.partidario_id) continue;
    let arr = byPart.get(c.partidario_id);
    if (!arr) { arr = []; byPart.set(c.partidario_id, arr); }
    arr.push(c);
  }
  const out: PartidarioAgg[] = [];
  for (const [id, list] of byPart) {
    let cab_sg = 0, cab_ef = 0;
    let peso_in_w = 0, peso_out_w = 0, gan_w = 0;
    let gmd_w = 0, gmd_n_w = 0;
    let dias_w = 0, dias_n_w = 0;
    let kg_total = 0;
    const por_cat: Record<string, number> = {};
    const origenes = new Set<string>();
    let precio_w = 0, precio_n_w = 0;
    let ingreso_fecha_min: string | null = null;

    for (const c of list) {
      cab_sg += c.cabezas_sisgado;
      const w = c.cabezas_sisgado;       // ponderado por cabezas reales medidas
      cab_ef += c.cabezas_efectivas;
      peso_in_w += c.peso_ingreso_prom * w;
      peso_out_w += c.peso_actual_prom * w;
      gan_w += c.ganancia_kg_prom * w;
      if (c.gmd_prom != null) { gmd_w += c.gmd_prom * w; gmd_n_w += w; }
      if (c.dias_prom > 0) { dias_w += c.dias_prom * w; dias_n_w += w; }
      kg_total += c.kg_totales_ganados;
      const k = c.categoria || '—';
      por_cat[k] = (por_cat[k] || 0) + c.cabezas_efectivas;
      c.origenes.forEach(o => origenes.add(o));
      if (c.precio_compra_bs_prom != null) { precio_w += c.precio_compra_bs_prom * w; precio_n_w += w; }
      if (c.ingreso_fecha_min && (!ingreso_fecha_min || c.ingreso_fecha_min < ingreso_fecha_min)) {
        ingreso_fecha_min = c.ingreso_fecha_min;
      }
    }
    out.push({
      id,
      nombre: list[0].partidario || id,
      compras: list,
      cabezas_sisgado: cab_sg,
      cabezas_efectivas: cab_ef,
      por_categoria: por_cat,
      peso_ingreso_prom: cab_sg > 0 ? Math.round((peso_in_w / cab_sg) * 10) / 10 : 0,
      peso_actual_prom: cab_sg > 0 ? Math.round((peso_out_w / cab_sg) * 10) / 10 : 0,
      ganancia_kg_prom: cab_sg > 0 ? Math.round((gan_w / cab_sg) * 10) / 10 : 0,
      gmd_prom: gmd_n_w > 0 ? Math.round((gmd_w / gmd_n_w) * 1000) / 1000 : null,
      kg_totales_ganados: Math.round(kg_total),
      origenes: [...origenes],
      precio_compra_bs_prom: precio_n_w > 0 ? Math.round(precio_w / precio_n_w) : null,
      ingreso_fecha_min,
      dias_prom: dias_n_w > 0 ? Math.round(dias_w / dias_n_w) : 0,
    });
  }
  return out.sort((a, b) => b.cabezas_efectivas - a.cabezas_efectivas);
}

// ---------- KPIs globales para overview ------------------------------------

export function aggGlobal() {
  const total_cabezas = animales.length;
  const total_kg_ganados = animales.reduce((s, a) => s + (a.ganancia_kg || 0), 0);
  const peso_prom_actual = animales.reduce((s, a) => s + a.last_peso, 0) / (total_cabezas || 1);
  const gmd = animales.filter(a => a.gmd_kg != null);
  const gmd_prom = gmd.length > 0 ? gmd.reduce((s, a) => s + (a.gmd_kg || 0), 0) / gmd.length : null;

  // ventas (sesiones tipo VT/VTA/VNT)
  const ventas = sesiones.filter(s => ['VT', 'VTA', 'VNT'].includes(s.trabajo_tipo || ''));
  const cabezas_vendidas = ventas.reduce((s, x) => s + x.n, 0);

  // cabezas en autoconsumo / refugo
  const autoconsumo = sesiones
    .filter(s => s.trabajo_tipo === 'AUT')
    .reduce((s, x) => s + x.n, 0);
  const refugo = sesiones
    .filter(s => s.trabajo_tipo === 'REFG' || s.trabajo_tipo === 'REFUG')
    .reduce((s, x) => s + x.n, 0);

  return {
    total_cabezas,
    total_kg_ganados: Math.round(total_kg_ganados),
    peso_prom_actual: Math.round(peso_prom_actual * 10) / 10,
    gmd_prom: gmd_prom != null ? Math.round(gmd_prom * 1000) / 1000 : null,
    cabezas_vendidas,
    autoconsumo,
    refugo,
    n_sesiones: sesiones.length,
  };
}

// Trabajos timeline
export function trabajosOrdenados(limit?: number) {
  const list = [...sesiones].sort((a, b) => (b.fecha_max || '').localeCompare(a.fecha_max || ''));
  return limit ? list.slice(0, limit) : list;
}

// ---------- ventas ---------------------------------------------------------

import { DESBASTE, PRECIO_VENTA_BS_KG, USD_RATE } from './config';

export type VentaSesion = Sesion & {
  peso_total_bruto: number;
  peso_total_neto: number;
  precio_efectivo_bs_kg: number;       // real si lo tenemos, fallback a config
  precio_es_estimado: boolean;
  ingreso_bs: number;
  ingreso_usd: number;
};

export function aggVentas(): VentaSesion[] {
  const ventas = sesiones
    .filter(s => ['VT', 'VTA', 'VNT'].includes(s.trabajo_tipo || ''))
    .map(s => {
      const peso_bruto = (s.peso_prom || 0) * s.n;
      const peso_neto = peso_bruto * (1 - DESBASTE);
      const real = s.precio_venta_bs_kg;
      const precio = real ?? PRECIO_VENTA_BS_KG;
      const ingreso_bs = peso_neto * precio;
      return {
        ...s,
        peso_total_bruto: Math.round(peso_bruto),
        peso_total_neto: Math.round(peso_neto),
        precio_efectivo_bs_kg: precio,
        precio_es_estimado: real == null,
        ingreso_bs: Math.round(ingreso_bs),
        ingreso_usd: Math.round(ingreso_bs / USD_RATE),
      };
    })
    .sort((a, b) => (b.fecha_max || '').localeCompare(a.fecha_max || ''));
  return ventas;
}

export function totalesVentas(ventas: VentaSesion[]) {
  const real = ventas.filter(v => !v.precio_es_estimado);
  return {
    n_ventas: ventas.length,
    cabezas: ventas.reduce((s, v) => s + v.n, 0),
    peso_neto: ventas.reduce((s, v) => s + v.peso_total_neto, 0),
    ingreso_bs: ventas.reduce((s, v) => s + v.ingreso_bs, 0),
    ingreso_usd: ventas.reduce((s, v) => s + v.ingreso_usd, 0),
    n_con_precio_real: real.length,
    cabezas_con_precio_real: real.reduce((s, v) => s + v.n, 0),
    ingreso_bs_real: real.reduce((s, v) => s + v.ingreso_bs, 0),
  };
}

// Animals helpers
export function animalesByRaza(raza_codigo: string): Animal[] {
  return animales.filter(a => (a.raza_codigo || a.raza_descripcion || '') === raza_codigo);
}

export function getAnimal(id: number | string): Animal | undefined {
  const idn = typeof id === 'string' ? Number(id) : id;
  return animales.find(a => a.id_animal === idn);
}

// Distribución por tipo de trabajo
export function trabajosPorTipo() {
  const map: Record<string, { n_sesiones: number; cabezas: number; tipo_label: string }> = {};
  for (const s of sesiones) {
    const k = s.trabajo_tipo || 'SIN_TIPO';
    const label = s.trabajo_tipo_label || 'Sin clasificar';
    if (!map[k]) map[k] = { n_sesiones: 0, cabezas: 0, tipo_label: label };
    map[k].n_sesiones++;
    map[k].cabezas += s.n;
  }
  return Object.entries(map)
    .map(([tipo, v]) => ({ tipo, ...v }))
    .sort((a, b) => b.cabezas - a.cabezas);
}
