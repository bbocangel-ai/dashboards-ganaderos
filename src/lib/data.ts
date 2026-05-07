/**
 * Data layer — runs at build time only. Aggregates the JSON snapshots
 * produced by `npm run sync` into the shapes each dashboard needs.
 */

import animalesRaw from '../../public/data/animales.json';
import sesionesRaw from '../../public/data/sesiones.json';
import metaRaw from '../../public/data/meta.json';

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
  first_fecha: string;
  first_peso: number;
  last_fecha: string;
  last_peso: number;
  n_pesajes: number;
  dias_en_campo: number;
  ganancia_kg: number;
  gmd_kg: number | null;
};

export type Sesion = {
  sesion: string;
  trabajo_tipo: string | null;
  trabajo_tipo_label: string | null;
  trabajo_fecha: string | null;
  trabajo_detalle: string | null;
  fecha_min: string | null;
  fecha_max: string | null;
  n: number;
  peso_prom: number | null;
  peso_min: number | null;
  peso_max: number | null;
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

export type PartidarioAgg = {
  id: string;
  nombre: string;
  cabezas: number;
  por_categoria: Record<string, number>;
  peso_ingreso_prom: number;
  peso_actual_prom: number;
  ganancia_kg_prom: number;
  gmd_prom: number | null;
  kg_totales_ganados: number;
};

export function aggPartidarios(): PartidarioAgg[] {
  const map = new Map<string, {
    nombre: string;
    cabezas: number;
    por_cat: Record<string, number>;
    peso_in_sum: number; peso_out_sum: number; gan_sum: number;
    gmd_sum: number; gmd_n: number;
  }>();

  for (const a of animales) {
    if (!a.partidario_id) continue;
    let g = map.get(a.partidario_id);
    if (!g) {
      g = {
        nombre: a.partidario || a.partidario_id,
        cabezas: 0, por_cat: {},
        peso_in_sum: 0, peso_out_sum: 0, gan_sum: 0, gmd_sum: 0, gmd_n: 0,
      };
      map.set(a.partidario_id, g);
    }
    g.cabezas++;
    const cat = a.categoria || '—';
    g.por_cat[cat] = (g.por_cat[cat] || 0) + 1;
    g.peso_in_sum += a.first_peso;
    g.peso_out_sum += a.last_peso;
    g.gan_sum += a.ganancia_kg;
    if (a.gmd_kg != null) { g.gmd_sum += a.gmd_kg; g.gmd_n++; }
  }

  const out: PartidarioAgg[] = [];
  for (const [id, g] of map) {
    out.push({
      id,
      nombre: g.nombre,
      cabezas: g.cabezas,
      por_categoria: g.por_cat,
      peso_ingreso_prom: Math.round((g.peso_in_sum / g.cabezas) * 10) / 10,
      peso_actual_prom: Math.round((g.peso_out_sum / g.cabezas) * 10) / 10,
      ganancia_kg_prom: Math.round((g.gan_sum / g.cabezas) * 10) / 10,
      gmd_prom: g.gmd_n > 0 ? Math.round((g.gmd_sum / g.gmd_n) * 1000) / 1000 : null,
      kg_totales_ganados: Math.round(g.gan_sum),
    });
  }
  return out.sort((a, b) => b.cabezas - a.cabezas);
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
