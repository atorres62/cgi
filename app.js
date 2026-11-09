'use strict';

/* ================= Catálogos ================= */
const TIPOS_PERSONA = ['Titular', 'Arrendatario', 'Esposa', 'Hijo', 'Sobrino', 'Nieto', 'Bisnieto', 'Otro'];
const GENEROS = ['Masculino', 'Femenino', 'Otro'];
const DEF_TIPOS_INGRESO = ['Aportación mensual', 'Reparación de lámparas', 'Mantenimiento', 'Cuota extraordinaria'];
const DEF_TIPOS_GASTO = ['Luz', 'Agua', 'Vigilancia', 'Jardinería', 'Reparación de lámparas', 'Limpieza', 'Papelería', 'Otro'];
const STORES = ['personas', 'ingresos', 'gastos', 'recibos', 'config'];

/* ================= Utilidades ================= */
const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const money = n => fmtMoney.format(+n || 0);
const round2 = n => Math.round((+n || 0) * 100) / 100;
const hoy = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtFecha = f => f ? f.split('-').reverse().join('/') : '';
const nombreCompleto = p => p ? [p.nombre, p.apPaterno, p.apMaterno].filter(Boolean).join(' ') : '(persona eliminada)';
const folioTxt = n => String(n).padStart(5, '0');
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const match = (q, ...vals) => !q || norm(vals.join(' ')).includes(norm(q.trim()));
const sum = (arr, f) => round2(arr.reduce((a, r) => a + (+(typeof f === 'function' ? f(r) : r[f]) || 0), 0));
const adeudoDe = i => round2((+i.cantidad || 0) - (+i.aportacion || 0)); // negativo = saldo a favor
const deuda = i => Math.max(0, adeudoDe(i));
const aFavor = i => Math.max(0, -adeudoDe(i));
const txtAdeudo = a => a < 0 ? 'Saldo a favor: ' + money(-a) : 'Adeudo: ' + money(a);
const mapById = a => Object.fromEntries(a.map(x => [x.id, x]));
const byFechaDesc = (a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.id - a.id;
const cmpCasa = (a, b) => String(a.numCasa || '').localeCompare(String(b.numCasa || ''), 'es', { numeric: true })
  || nombreCompleto(a).localeCompare(nombreCompleto(b), 'es');
const trimAll = d => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

/* ================= Base de datos (IndexedDB) ================= */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('cgi-db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['personas', 'ingresos', 'gastos', 'recibos'])
        if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('config')) d.createObjectStore('config', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const dbReady = openDB().then(d => (db = d));
function tx(stores, mode, fn) {
  return dbReady.then(() => new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    try { out = fn(t); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const all = s => tx(s, 'readonly', t => t.objectStore(s).getAll());
const get = (s, id) => tx(s, 'readonly', t => t.objectStore(s).get(id));
const put = (s, o) => tx(s, 'readwrite', t => t.objectStore(s).put(o));
const del = (s, id) => tx(s, 'readwrite', t => t.objectStore(s).delete(id));

let cfg = {};
async function loadConfig() {
  const rows = await all('config');
  cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  cfg.org ??= 'Asociación de Colonos';
  // Cada tipo de ingreso: { nombre, cantidad }. cantidad 0 = monto variable (se captura a mano).
  cfg.tiposIngreso = (cfg.tiposIngreso ?? DEF_TIPOS_INGRESO).map(t => typeof t === 'string' ? { nombre: t, cantidad: 0 } : t);
  cfg.tiposGasto ??= DEF_TIPOS_GASTO.slice();
  cfg.folio ??= 0;
  cfg.recibe ??= '';          // nombre de quien recibe (aparece en los recibos)
  cfg.cargoRecibe ??= 'Tesorero(a)';
  cfg.firmaId ??= '';          // firma vigente; cada firma se guarda en config como 'firma_<id>'
}
const firmaUrl = id => (id && cfg['firma_' + id]) || '';
const setCfg = (key, value) => { cfg[key] = value; return put('config', { key, value }); };
const tipoIng = nombre => cfg.tiposIngreso.find(t => t.nombre === nombre);
const cantidadTipo = nombre => +tipoIng(nombre)?.cantidad || 0;

/* ================= Estado y navegación ================= */
const state = { view: 'inicio', mes: hoy().slice(0, 7), q: '', soloAdeudo: false, tipoPersona: '', estadoPago: '', tipoIngreso: '', activo: '' };
const ESTADOS_PAGO = [['', 'Todos'], ['adeudo', 'Con adeudo'], ['pagados', 'Pagados']];

// Resumen de adeudos por persona: { adeudo, n (ingresos registrados), porTipo: {tipo: importe} }.
// Si hay filtro de tipo de ingreso, solo considera ese tipo.
function adeudosPorPersona(ing, tipo = state.tipoIngreso) {
  const m = {};
  for (const i of ing) {
    if (tipo && i.tipo !== tipo) continue;
    const r = m[i.personaId] ||= { adeudo: 0, n: 0, porTipo: {} };
    r.n++;
    const d = deuda(i);
    if (d > 0) { r.adeudo = round2(r.adeudo + d); r.porTipo[i.tipo] = round2((r.porTipo[i.tipo] || 0) + d); }
  }
  return m;
}
const SIN_INFO = { adeudo: 0, n: 0, porTipo: {} };
const detalleAdeudo = info => Object.entries(info.porTipo).map(([t, v]) => `${t} ${money(v)}`).join(' · ')
  || (state.tipoIngreso && !info.n ? 'Sin registro' : '');

// Filtros de la pestaña Personas (también los usa el listado completo).
// Con un tipo de ingreso elegido, "Pagados" exige que la persona tenga registrado ese ingreso.
const esActiva = p => p.activo !== false; // las personas registradas antes de este campo se consideran activas
const ESTADOS_ACTIVO = [['', 'Activas e inactivas'], ['si', 'Solo activas'], ['no', 'Solo inactivas']];
const pasaFiltroPersona = (p, info) => (!state.tipoPersona || p.tipo === state.tipoPersona)
  && (!state.activo || esActiva(p) === (state.activo === 'si'))
  && (!state.estadoPago || (state.estadoPago === 'adeudo' ? info.adeudo > 0 : info.adeudo <= 0 && (!state.tipoIngreso || info.n > 0)))
  && match(state.q, nombreCompleto(p), p.numCasa, p.telefono, p.email, p.tipo);
const enMes = r => !state.mes || (r.fecha || '').startsWith(state.mes);

const ctlMes = () => `<div class="filtros">
  <label class="mes">Periodo <input type="month" data-filter="mes" value="${state.mes}"></label>
  <button class="chip ${state.mes ? '' : 'on'}" data-act="todoPeriodo">Todo</button></div>`;
const ctlBuscar = ph => `<input type="search" class="buscar" data-filter="q" placeholder="${ph}" value="${esc(state.q)}">`;

const VIEWS = {
  inicio: { t: 'Inicio', ctl: ctlMes, list: listInicio },
  personas: {
    t: 'Personas', list: listPersonas, fab: () => formPersona(),
    ctl: () => `<div class="filtros">${ctlBuscar('Buscar nombre, casa, teléfono…')}<button class="btn" data-act="listadoPersonas">📋 Listado</button></div>
      <div class="filtros">
        <select class="buscar" data-filter="tipoPersona" aria-label="Tipo de persona"><option value="">Todas las personas</option>${TIPOS_PERSONA.map(t => `<option ${t === state.tipoPersona ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <select class="buscar" data-filter="tipoIngreso" aria-label="Tipo de ingreso"><option value="">Todos los ingresos</option>${cfg.tiposIngreso.map(t => `<option ${t.nombre === state.tipoIngreso ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('')}</select>
      </div>
      <div class="filtros"><select class="buscar" data-filter="activo" aria-label="Activas">${ESTADOS_ACTIVO.map(([v, t]) => `<option value="${v}" ${state.activo === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
       <div class="seg">${ESTADOS_PAGO.map(([v, t]) => `<button class="chip ${state.estadoPago === v ? 'on' : ''}" data-act="estadoPago" data-id="${v}">${t}</button>`).join('')}</div>`
  },
  ingresos: {
    t: 'Ingresos', list: listIngresos, fab: () => formIngreso(),
    ctl: () => ctlMes() + `<div class="filtros">${ctlBuscar('Buscar persona, casa, tipo…')}<button class="btn" data-act="generarCuentas">🧾 Cuentas por pagar</button></div>` +
      `<label class="check"><input type="checkbox" data-filter="soloAdeudo" ${state.soloAdeudo ? 'checked' : ''}> Solo con adeudo</label>`
  },
  gastos: { t: 'Gastos', list: listGastos, fab: () => formGasto(), ctl: () => ctlMes() + ctlBuscar('Buscar tipo o descripción…') },
  recibos: {
    t: 'Recibos de ingreso', list: listRecibos,
    ctl: () => ctlMes() + `<div class="filtros">${ctlBuscar('Buscar folio, nombre, concepto, UUID…')}<button class="btn" data-act="buscarFolio">🔎 Folio</button></div>`
  },
};

function go(v) { closeModal(); state.view = v; state.q = ''; window.scrollTo(0, 0); render(); }
async function render() {
  const V = VIEWS[state.view];
  $('#titulo').textContent = V.t;
  $('#fab').hidden = !V.fab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
  $('#view').innerHTML = `<div class="controles">${V.ctl()}</div><div id="lista"></div>`;
  await renderList();
}
async function renderList() {
  const el = $('#lista');
  if (el) el.innerHTML = await VIEWS[state.view].list();
}

/* ================= Componentes ================= */
const vacio = m => `<p class="vacio">${m}</p>`;
const kpi = (t, v, c) => `<div class="kpi"><span>${t}</span><strong class="${c || (v < 0 ? 'neg' : 'pos')}">${money(v)}</strong></div>`;
const resumen = items => `<div class="resumen">${items.map(([t, v, c]) => `<div><span>${t}</span><b class="${c}">${money(v)}</b></div>`).join('')}</div>`;
const tablaTipo = (t, rows) => rows.length ? `<h3 class="sec">${t}</h3><div class="lista-simple">${rows.map(([k, v]) => `<div class="fila"><span>${esc(k)}</span><span>${money(v)}</span></div>`).join('')}</div>` : '';
const fld = (label, name, val, attrs = '') => `<label>${label}<input name="${name}" value="${esc(val ?? '')}" ${attrs}></label>`;
const sel = (label, name, opts, val, blank) => {
  if (val && !opts.includes(val)) opts = [...opts, val];
  return `<label>${label}<select name="${name}" ${blank ? '' : 'required'}>${blank ? '<option value="">—</option>' : ''}${opts.map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
};
const botones = (delAct, id, extra = '') => `<div class="acciones">
  ${id ? `<button type="button" class="btn danger" data-act="${delAct}" data-id="${id}">Eliminar</button>` : ''}${extra}
  <button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>`;

function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function closeModal() { const m = $('#modal'); if (m.open) m.close(); }
/* onSubmit: devuelve false para no cerrar; o una función para ejecutar tras cerrar */
function openModal(html, onSubmit) {
  $('#modal').classList.remove('ancho');
  $('#modalBody').innerHTML = html;
  const f = $('#modalBody form');
  if (f && onSubmit) f.onsubmit = async e => {
    e.preventDefault();
    const r = await onSubmit(Object.fromEntries(new FormData(f)), f);
    if (r === false) return;
    closeModal(); await renderList();
    if (typeof r === 'function') r();
  };
  const m = $('#modal');
  if (!m.open) m.showModal();
  m.scrollTop = 0;
}

/* ================= Inicio ================= */
async function listInicio() {
  const [ing, gas, per] = await Promise.all([all('ingresos'), all('gastos'), all('personas')]);
  const pm = mapById(per);
  const i = ing.filter(enMes), g = gas.filter(enMes);
  const totI = sum(i, 'aportacion'), totG = sum(g, 'importe');
  const caja = round2(sum(ing, 'aportacion') - sum(gas, 'importe'));
  const porTipo = (arr, campo) => {
    const m = {};
    arr.forEach(r => { const k = r.tipo || 'Sin tipo'; m[k] = (m[k] || 0) + (+r[campo] || 0); });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const deud = {};
  ing.forEach(r => { const a = adeudoDe(r); if (a > 0) deud[r.personaId] = round2((deud[r.personaId] || 0) + a); });
  const deudores = Object.entries(deud).sort((a, b) => b[1] - a[1]);
  return avisoRespaldo(per.length + ing.length + gas.length) + `<div class="kpis">
      ${kpi('Ingresos', totI, 'pos')}${kpi('Gastos', totG, 'neg')}
      ${kpi('Balance del periodo', round2(totI - totG))}${kpi('Adeudo del periodo', sum(i, deuda), 'neg')}
    </div>
    <div class="card caja"><span>Saldo en caja (histórico)</span><strong class="${caja < 0 ? 'neg' : ''}">${money(caja)}</strong></div>
    ${tablaTipo('Ingresos por tipo', porTipo(i, 'aportacion'))}
    ${tablaTipo('Gastos por tipo', porTipo(g, 'importe'))}
    <h3 class="sec">Adeudos pendientes (todos los periodos)</h3>
    ${deudores.length ? `<div class="lista-simple">${deudores.map(([pid, a]) => {
      const p = pm[pid];
      return `<div class="fila" data-act="verPersona" data-id="${pid}"><span>${p ? `<b>Casa ${esc(p.numCasa)}</b> · ${esc(nombreCompleto(p))}` : '(persona eliminada)'}</span><span class="neg">${money(a)}</span></div>`;
    }).join('')}</div>` : vacio('Sin adeudos pendientes 🎉')}`;
}

/* ---- Aviso de respaldo: si hay datos y pasaron DIAS_RESPALDO días (o nunca se respaldó) ---- */
const DIAS_RESPALDO = 7;
const diasDesde = f => Math.floor((Date.parse(hoy()) - Date.parse(f)) / 864e5);
function avisoRespaldo(nDatos) {
  const ult = cfg.ultimoRespaldo;
  if (!nDatos || cfg.respaldoPospuesto === hoy() || (ult && diasDesde(ult) < DIAS_RESPALDO)) return '';
  const msg = ult ? `Tu último respaldo fue hace <b>${diasDesde(ult)} días</b> (${fmtFecha(ult)}).` : 'Aún <b>no has descargado ningún respaldo</b>.';
  return `<div class="card aviso-respaldo">
    <p>⚠️ ${msg} Los datos solo están en este dispositivo: si se borra el navegador o se pierde, se pierden.</p>
    <div class="acciones"><button class="btn" data-act="posponerRespaldo">Recordar mañana</button><button class="btn primary" data-act="exportJSON">⬇ Descargar respaldo</button></div></div>`;
}

/* ================= Personas ================= */
async function listPersonas() {
  const [per, ing] = await Promise.all([all('personas'), all('ingresos')]);
  const m = adeudosPorPersona(ing), info = p => m[p.id] || SIN_INFO;
  const L = per.filter(p => pasaFiltroPersona(p, info(p))).sort(cmpCasa);
  if (!L.length) return vacio(per.length ? 'Sin resultados para el filtro' : 'Aún no hay personas. Toca + para agregar.');
  const total = sum(L, p => info(p).adeudo);
  return `<p class="conteo">${L.length} persona(s)${total > 0 ? ` · Adeudo total <b class="neg">${money(total)}</b>` : ''}</p>` + L.map(p => {
    const i = info(p), det = detalleAdeudo(i);
    return `<div class="card item ${esActiva(p) ? '' : 'inactiva'}" data-act="verPersona" data-id="${p.id}">
      <div class="casa">${esc(p.numCasa || '—')}</div>
      <div class="info"><b>${esc(nombreCompleto(p))}${esActiva(p) ? '' : ' <span class="badge">Inactiva</span>'}</b>
        <small>${esc(p.tipo)}${p.genero ? ' · ' + esc(p.genero) : ''}${p.telefono ? ' · ' + esc(p.telefono) : ''}</small>
        ${det ? `<small class="${i.adeudo > 0 ? 'neg' : ''}">${i.adeudo > 0 ? 'Debe: ' : ''}${esc(det)}</small>` : ''}</div>
      ${i.adeudo > 0 ? `<span class="badge neg">${money(i.adeudo)}</span>` : ''}
    </div>`;
  }).join('');
}

async function formPersona(p = {}) {
  let extra = '';
  if (p.id) {
    const ing = (await all('ingresos')).filter(i => i.personaId === p.id).sort(byFechaDesc);
    const ad = sum(ing, deuda), fav = sum(ing, aFavor);
    extra = `<div class="edo"><h4>Estado de cuenta</h4>
      <p>Aportado: <b>${money(sum(ing, 'aportacion'))}</b> · Adeudo: <b class="${ad > 0 ? 'neg' : 'pos'}">${money(ad)}</b>${fav > 0 ? ` · A favor: <b class="pos">${money(fav)}</b>` : ''}</p>
      ${ing.filter(i => adeudoDe(i) > 0).map(i => `<div class="fila" data-act="editIngreso" data-id="${i.id}"><span>${fmtFecha(i.fecha)} · ${esc(i.tipo)}</span><span class="neg">${money(adeudoDe(i))}</span></div>`).join('')}
      ${p.telefono ? `<p class="links"><a href="tel:${esc(p.telefono)}">📞 Llamar</a> <a target="_blank" rel="noopener" href="${waLink(p.telefono, '')}">💬 WhatsApp</a></p>` : ''}
    </div>`;
  }
  openModal(`<form>
    <h2>${p.id ? 'Editar' : 'Nueva'} persona</h2>
    ${fld('Nombre', 'nombre', p.nombre, 'required autocomplete="off"')}
    ${fld('Apellido paterno', 'apPaterno', p.apPaterno, 'required autocomplete="off"')}
    ${fld('Apellido materno', 'apMaterno', p.apMaterno, 'autocomplete="off"')}
    <div class="row2">${fld('Número de casa', 'numCasa', p.numCasa, 'required autocomplete="off"')}${sel('Tipo de persona', 'tipo', TIPOS_PERSONA, p.tipo || 'Titular')}</div>
    ${sel('Género', 'genero', GENEROS, p.genero, true)}
    ${fld('Teléfono', 'telefono', p.telefono, 'type="tel" inputmode="tel"')}
    ${fld('Email', 'email', p.email, 'type="email" inputmode="email"')}
    <label class="check"><input type="checkbox" name="activo" ${esActiva(p) ? 'checked' : ''}> Activo (se le generan cuentas por pagar)</label>
    ${extra}
    ${botones('delPersona', p.id)}
  </form>`, async d => {
    await put('personas', { ...p, ...trimAll(d), activo: d.activo === 'on' });
    toast('Persona guardada');
  });
}

/* ---- Listado completo de personas (tabla) ---- */
const COLS_PERSONA = [['numCasa', 'Casa'], ['nombre', 'Nombre'], ['apPaterno', 'Apellido paterno'], ['apMaterno', 'Apellido materno'],
  ['tipo', 'Tipo'], ['genero', 'Género'], ['telefono', 'Teléfono'], ['email', 'Email'], ['activoTxt', 'Activo'], ['detalle', 'Concepto del adeudo'], ['adeudo', 'Adeudo']];
let ordenListado = 'numCasa';

async function listadoPersonas(col) {
  if (typeof col === 'string' && col) ordenListado = col;
  const [per, ing] = await Promise.all([all('personas'), all('ingresos')]);
  const m = adeudosPorPersona(ing);
  per.forEach(p => { p.info = m[p.id] || SIN_INFO; p.adeudo = p.info.adeudo; p.detalle = detalleAdeudo(p.info); p.activoTxt = esActiva(p) ? 'Sí' : 'No'; });
  const cmp = ordenListado === 'numCasa' ? cmpCasa
    : ordenListado === 'adeudo' ? (a, b) => b.adeudo - a.adeudo || cmpCasa(a, b)
    : (a, b) => String(a[ordenListado] || '').localeCompare(String(b[ordenListado] || ''), 'es', { numeric: true }) || cmpCasa(a, b);
  const L = per.filter(p => pasaFiltroPersona(p, p.info)).sort(cmp);
  const filtro = [state.estadoPago && ESTADOS_PAGO.find(e => e[0] === state.estadoPago)[1],
    state.tipoIngreso && 'Ingreso: ' + state.tipoIngreso,
    state.tipoPersona && 'Tipo: ' + state.tipoPersona, state.activo && ESTADOS_ACTIVO.find(e => e[0] === state.activo)[1], state.q && `Búsqueda: "${state.q}"`].filter(Boolean).join(' · ');
  openModal(`<div class="print-area listado">
      <h2>Listado de personas</h2>
      <p class="nota">${esc(cfg.org)} · ${L.length} persona(s) · ${fmtFecha(hoy())}${filtro ? ' · ' + esc(filtro) : ''}</p>
      <div class="tabla-wrap"><table class="tabla">
        <thead><tr><th>#</th>${COLS_PERSONA.map(([k, t]) => `<th data-act="listadoPersonas" data-id="${k}" class="${k === ordenListado ? 'ord' : ''}">${t}${k === ordenListado ? ' ▾' : ''}</th>`).join('')}</tr></thead>
        <tbody>${L.map((p, n) => `<tr data-act="verPersona" data-id="${p.id}"><td>${n + 1}</td>${COLS_PERSONA.map(([k]) =>
          k === 'adeudo' ? `<td class="num ${p.adeudo > 0 ? 'neg' : ''}">${money(p.adeudo)}</td>`
          : k === 'detalle' ? `<td class="detalle">${esc(p.detalle)}</td>` : `<td>${esc(p[k] || '')}</td>`).join('')}</tr>`).join('')
          || `<tr><td colspan="${COLS_PERSONA.length + 1}" class="vacio">Sin personas</td></tr>`}</tbody>
        ${L.length ? `<tfoot><tr><td colspan="${COLS_PERSONA.length}">Total adeudo</td><td class="num neg">${money(sum(L, 'adeudo'))}</td></tr></tfoot>` : ''}
      </table></div>
      <p class="nota no-print">Toca el encabezado de una columna para ordenar, o una fila para editar a la persona.</p>
    </div>
    <div class="acciones no-print">
      <button class="btn" data-act="print">Imprimir / PDF</button>
      <button class="btn" data-act="exportCSV" data-id="personas">Exportar a Excel</button>
      <button class="btn primary" data-act="close">Cerrar</button>
    </div>`);
  $('#modal').classList.add('ancho');
}

async function delPersona(id) {
  const n = (await all('ingresos')).filter(i => i.personaId === id).length;
  if (n) { alert(`No se puede eliminar: tiene ${n} ingreso(s) registrado(s).`); return; }
  if (!confirm('¿Eliminar esta persona?')) return;
  await del('personas', id); closeModal(); toast('Persona eliminada'); renderList();
}

/* ================= Ingresos ================= */
async function listIngresos() {
  const [ing, per] = await Promise.all([all('ingresos'), all('personas')]);
  const pm = mapById(per);
  const L = ing.filter(i => enMes(i) && (!state.soloAdeudo || adeudoDe(i) > 0)
    && match(state.q, nombreCompleto(pm[i.personaId]), pm[i.personaId]?.numCasa, i.tipo, i.nota)).sort(byFechaDesc);
  if (!L.length) return vacio(ing.length ? 'Sin resultados para el filtro' : 'Aún no hay ingresos. Toca + para registrar.');
  return resumen([['Aportado', sum(L, 'aportacion'), 'pos'], ['Adeudo', sum(L, deuda), 'neg']]) + L.map(i => {
    const p = pm[i.personaId], a = adeudoDe(i);
    return `<div class="card item" data-act="editIngreso" data-id="${i.id}">
      <div class="casa">${esc(p?.numCasa || '—')}</div>
      <div class="info"><b>${esc(nombreCompleto(p))}</b>
        <small>${esc(i.tipo)} · ${fmtFecha(i.fecha)}</small>
        <small>A aportar ${money(i.cantidad)} · Aportado ${money(i.aportacion)}</small></div>
      <span class="badge ${a > 0 ? 'neg' : 'pos'}">${a > 0 ? 'Debe ' + money(a) : a < 0 ? 'A favor ' + money(-a) : 'Pagado'}</span></div>`;
  }).join('');
}

async function formIngreso(i = {}) {
  const per = (await all('personas')).sort(cmpCasa);
  if (!per.length) { toast('Primero registra una persona'); go('personas'); return; }
  const nuevo = !i.id;
  let recibosHtml = '';
  if (!nuevo) {
    const rs = (await all('recibos')).filter(r => r.ingresoId === i.id).sort((a, b) => a.folio - b.folio);
    if (rs.length) recibosHtml = `<div class="edo"><h4>Recibos emitidos</h4>${rs.map(r => `<div class="fila" data-act="verRecibo" data-id="${r.id}"><span>Folio ${folioTxt(r.folio)} · ${fmtFecha(r.fecha)}${r.cancelado ? ' · CANCELADO' : ''}</span><span>${money(r.importe)}</span></div>`).join('')}</div>`;
  }
  const ad = nuevo ? 0 : adeudoDe(i);
  const tipo0 = i.tipo || cfg.tiposIngreso[0].nombre;
  const cant0 = nuevo ? (cantidadTipo(tipo0) || '') : i.cantidad;
  const fijo = cantidadTipo(tipo0) > 0;
  const num = 'type="number" step="0.01" min="0" inputmode="decimal" required';
  openModal(`<form>
    <h2>${nuevo ? 'Registrar' : 'Editar'} ingreso</h2>
    <label>Persona<select name="personaId" required><option value="">Selecciona…</option>
      ${per.filter(p => esActiva(p) || p.id === i.personaId).map(p => `<option value="${p.id}" ${p.id === i.personaId ? 'selected' : ''}>Casa ${esc(p.numCasa)} – ${esc(nombreCompleto(p))}${esActiva(p) ? '' : ' (inactiva)'}</option>`).join('')}</select></label>
    ${sel('Tipo de ingreso', 'tipo', cfg.tiposIngreso.map(t => t.nombre), tipo0)}
    <div class="row2">${fld('Cantidad a aportar', 'cantidad', cant0, num + (fijo ? ' readonly' : ''))}${fld(nuevo ? 'Aportación' : 'Aportado (usa Abonar)', 'aportacion', nuevo ? cant0 : i.aportacion, num + (nuevo ? '' : ' readonly'))}</div>
    <p class="nota" id="hintCant">${fijo ? 'Cantidad fija del tipo de ingreso (se cambia en ⚙︎ Configuración).' : 'Este tipo tiene monto variable: captura la cantidad.'}</p>
    <div class="adeudo-live"><b id="adeudoLive">${txtAdeudo(ad)}</b></div>
    ${fld('Fecha de aportación', 'fecha', i.fecha || hoy(), 'type="date" required')}
    ${fld('Nota (opcional)', 'nota', i.nota)}
    ${recibosHtml}
    ${botones('delIngreso', i.id, !nuevo && ad > 0 ? `<button type="button" class="btn" data-act="abonar" data-id="${i.id}">Abonar</button>` : '')}
  </form>`, async d => {
    const cantidad = round2(d.cantidad);
    const aportacion = nuevo ? round2(d.aportacion) : round2(i.aportacion);
    const o = { ...i, personaId: Number(d.personaId), tipo: d.tipo, cantidad, aportacion, adeudo: round2(cantidad - aportacion), fecha: d.fecha, nota: d.nota.trim() };
    if (nuevo) o.abonos = [];
    o.id = await put('ingresos', o);
    if (nuevo && aportacion > 0) {
      const r = await crearRecibo(o, per.find(x => x.id === o.personaId), aportacion, o.fecha);
      toast('Ingreso guardado · Recibo ' + folioTxt(r.folio));
      return () => verRecibo(r.id);
    }
    toast('Ingreso guardado');
  });
  const f = $('#modalBody form');
  const upd = () => { $('#adeudoLive').textContent = txtAdeudo(round2(f.cantidad.value) - round2(f.aportacion.value)); };
  f.addEventListener('input', upd);
  f.tipo.addEventListener('change', () => {
    const c = cantidadTipo(f.tipo.value);
    f.cantidad.readOnly = c > 0;
    f.cantidad.value = c > 0 ? c : '';
    if (nuevo) f.aportacion.value = f.cantidad.value;
    $('#hintCant').textContent = c > 0 ? 'Cantidad fija del tipo de ingreso (se cambia en ⚙︎ Configuración).' : 'Este tipo tiene monto variable: captura la cantidad.';
    upd();
  });
}

async function abonar(id) {
  const i = await get('ingresos', id), ad = adeudoDe(i);
  openModal(`<form><h2>Abonar a adeudo</h2>
    <p>${esc(i.tipo)} · ${fmtFecha(i.fecha)}<br>Adeudo actual: <b class="neg">${money(ad)}</b></p>
    ${fld('Importe del abono', 'monto', ad, 'type="number" step="0.01" min="0.01" inputmode="decimal" required')}
    ${fld('Fecha', 'fecha', hoy(), 'type="date" required')}
    <div class="acciones"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Registrar abono</button></div>
  </form>`, async d => {
    const monto = round2(d.monto);
    if (monto <= 0) { toast('Importe inválido'); return false; }
    i.aportacion = round2(i.aportacion + monto);
    i.adeudo = adeudoDe(i);
    (i.abonos ||= []).push({ fecha: d.fecha, monto });
    await put('ingresos', i);
    const r = await crearRecibo(i, await get('personas', i.personaId), monto, d.fecha);
    toast('Abono registrado · Recibo ' + folioTxt(r.folio));
    return () => verRecibo(r.id);
  });
}

async function delIngreso(id) {
  if (!confirm('¿Eliminar este ingreso? Sus recibos quedarán marcados como CANCELADOS.')) return;
  for (const r of (await all('recibos')).filter(r => r.ingresoId === id)) { r.cancelado = true; await put('recibos', r); }
  await del('ingresos', id); closeModal(); toast('Ingreso eliminado'); renderList();
}

/* ---- Cuentas por pagar: un cargo (ingreso con aportación 0) por persona activa y tipo de ingreso con cantidad fija ---- */
async function generarCuentas() {
  const fijos = cfg.tiposIngreso.filter(t => +t.cantidad > 0);
  if (!fijos.length) { alert('No hay tipos de ingreso con cantidad fija. Asígnales una cantidad en ⚙︎ Configuración.'); return; }
  const activas = (await all('personas')).filter(esActiva);
  if (!activas.length) { alert('No hay personas activas.'); return; }
  openModal(`<form><h2>Generar cuentas por pagar</h2>
    <p class="nota">Se creará un cargo a cada una de las <b>${activas.length} persona(s) activa(s)</b> por cada tipo de ingreso elegido, con aportación $0 (todo queda como adeudo).
      Si la persona ya tiene ese tipo de ingreso en el mismo mes, no se duplica.</p>
    <label>Tipos de ingreso (cantidad fija)</label>
    <div class="lista-check">${fijos.map(t => `<label class="check"><input type="checkbox" name="tipos" value="${esc(t.nombre)}" checked> ${esc(t.nombre)} · ${money(t.cantidad)}</label>`).join('')}</div>
    ${fld('Fecha del cargo', 'fecha', hoy(), 'type="date" required')}
    <div class="acciones"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Generar</button></div>
  </form>`, async (d, f) => {
    const tipos = new FormData(f).getAll('tipos');
    if (!tipos.length) { toast('Elige al menos un tipo de ingreso'); return false; }
    const mes = d.fecha.slice(0, 7);
    const existe = new Set((await all('ingresos')).filter(i => (i.fecha || '').startsWith(mes)).map(i => i.personaId + '|' + i.tipo));
    const nuevos = [];
    for (const p of activas) for (const t of fijos.filter(t => tipos.includes(t.nombre))) {
      if (existe.has(p.id + '|' + t.nombre)) continue;
      nuevos.push({ personaId: p.id, tipo: t.nombre, cantidad: round2(t.cantidad), aportacion: 0, adeudo: round2(t.cantidad), fecha: d.fecha, nota: 'Cuenta por pagar generada' });
    }
    const omitidos = activas.length * tipos.length - nuevos.length;
    if (!nuevos.length) { alert(`No se generó nada: todas las personas activas ya tienen esos ingresos en ${mes}.`); return false; }
    if (!confirm(`Se crearán ${nuevos.length} cuenta(s) por pagar por ${money(sum(nuevos, 'cantidad'))}${omitidos ? ` (se omiten ${omitidos} que ya existen en ese mes)` : ''}. ¿Continuar?`)) return false;
    await tx('ingresos', 'readwrite', t => { const st = t.objectStore('ingresos'); nuevos.forEach(o => st.add(o)); });
    state.mes = mes; state.soloAdeudo = false; state.q = '';
    toast(`${nuevos.length} cuenta(s) por pagar generada(s)`);
    return () => render();
  });
}

/* ================= Gastos ================= */
async function listGastos() {
  const g = await all('gastos');
  const L = g.filter(x => enMes(x) && match(state.q, x.tipo, x.descripcion)).sort(byFechaDesc);
  if (!L.length) return vacio(g.length ? 'Sin resultados para el filtro' : 'Aún no hay gastos. Toca + para registrar.');
  return resumen([['Total gastado', sum(L, 'importe'), 'neg']]) + L.map(x => `
    <div class="card item" data-act="editGasto" data-id="${x.id}">
      <div class="info"><b>${esc(x.tipo)}</b><small>${fmtFecha(x.fecha)}${x.descripcion ? ' · ' + esc(x.descripcion) : ''}</small></div>
      <span class="monto neg">${money(x.importe)}</span></div>`).join('');
}

function formGasto(g = {}) {
  openModal(`<form><h2>${g.id ? 'Editar' : 'Registrar'} gasto</h2>
    ${sel('Tipo de gasto', 'tipo', cfg.tiposGasto, g.tipo || cfg.tiposGasto[0])}
    <div class="row2">${fld('Fecha', 'fecha', g.fecha || hoy(), 'type="date" required')}${fld('Importe gastado', 'importe', g.importe, 'type="number" step="0.01" min="0.01" inputmode="decimal" required')}</div>
    ${fld('Descripción / proveedor (opcional)', 'descripcion', g.descripcion)}
    ${botones('delGasto', g.id)}
  </form>`, async d => {
    await put('gastos', { ...g, tipo: d.tipo, fecha: d.fecha, importe: round2(d.importe), descripcion: d.descripcion.trim() });
    toast('Gasto guardado');
  });
}

async function delGasto(id) {
  if (!confirm('¿Eliminar este gasto?')) return;
  await del('gastos', id); closeModal(); toast('Gasto eliminado'); renderList();
}

/* ================= Recibos ================= */
// Identificador único universal del recibo (UUID v4).
const nuevoUUID = () => crypto.randomUUID?.() ?? '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
  (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

// Asigna UUID a los recibos creados antes de esta función (o que vienen de un respaldo anterior).
async function asegurarUUIDs() {
  for (const r of (await all('recibos')).filter(r => !r.uuid)) { r.uuid = nuevoUUID(); await put('recibos', r); }
}

// Los folios son consecutivos y nunca se reutilizan (un folio cancelado queda cancelado).
async function crearRecibo(ing, persona, importe, fecha) {
  const folio = (+cfg.folio || 0) + 1;
  await setCfg('folio', folio);
  const r = {
    uuid: nuevoUUID(), folio, fecha, personaId: ing.personaId, nombre: nombreCompleto(persona), casa: persona?.numCasa || '',
    concepto: ing.tipo, cantidad: ing.cantidad, importe, adeudo: adeudoDe(ing), ingresoId: ing.id, creado: new Date().toISOString(),
    recibio: cfg.recibe, cargoRecibio: cfg.cargoRecibe, firmaId: cfg.firmaId
  };
  r.id = await put('recibos', r);
  return r;
}

async function listRecibos() {
  const rs = await all('recibos');
  const L = rs.filter(r => enMes(r) && match(state.q, folioTxt(r.folio), r.nombre, r.casa, r.concepto, r.uuid)).sort((a, b) => b.folio - a.folio);
  if (!L.length) return vacio(rs.length ? 'Sin resultados para el filtro' : 'Los recibos se generan automáticamente al registrar un ingreso o un abono.');
  return L.map(r => `
    <div class="card item ${r.cancelado ? 'tachado' : ''}" data-act="verRecibo" data-id="${r.id}">
      <div class="folio-box">${folioTxt(r.folio)}</div>
      <div class="info"><b>${esc(r.nombre)}</b><small>${esc(r.concepto)} · ${fmtFecha(r.fecha)}</small>
        <small>${r.cancelado ? 'CANCELADO' : r.adeudo > 0 ? 'Adeudo ' + money(r.adeudo) : r.adeudo < 0 ? 'Saldo a favor ' + money(-r.adeudo) : 'Sin adeudo'}</small></div>
      <span class="monto pos">${money(r.importe)}</span></div>`).join('');
}

// Quién recibió: el guardado en el recibo; los recibos anteriores a esta función usan la configuración actual.
const quienRecibe = r => ({ nombre: r.recibio ?? cfg.recibe, cargo: r.cargoRecibio ?? cfg.cargoRecibe, firma: firmaUrl(r.firmaId ?? cfg.firmaId) });
const waLink = (tel, text) => {
  let d = String(tel).replace(/\D/g, '');
  if (d.length === 10) d = '52' + d; // número mexicano a 10 dígitos
  return `https://wa.me/${d}${text ? '?text=' + encodeURIComponent(text) : ''}`;
};

async function verRecibo(id) {
  const r = await get('recibos', id);
  const q = quienRecibe(r);
  openModal(`<div class="recibo print-area ${r.cancelado ? 'cancelado' : ''}">
      <div class="r-head"><div><strong>${esc(cfg.org)}</strong><div class="r-tit">RECIBO DE INGRESO</div></div>
        <div class="r-folio">Folio<br><b>${folioTxt(r.folio)}</b></div></div>
      <dl>
        <dt>Fecha</dt><dd>${fmtFecha(r.fecha)}</dd>
        <dt>Recibí de</dt><dd>${esc(r.nombre)}</dd>
        <dt>Casa</dt><dd>${esc(r.casa)}</dd>
        <dt>Concepto</dt><dd>${esc(r.concepto)}</dd>
        <dt>Cantidad a aportar</dt><dd>${money(r.cantidad)}</dd>
        <dt>Importe recibido</dt><dd class="grande">${money(r.importe)}</dd>
        <dt>${r.adeudo < 0 ? 'Saldo a favor' : 'Adeudo'}</dt><dd class="${r.adeudo > 0 ? 'neg' : r.adeudo < 0 ? 'pos' : ''}">${money(Math.abs(r.adeudo))}</dd>
      </dl>
      ${r.cancelado ? `<div class="sello">CANCELADO</div>${r.fechaCancelacion ? `<p class="nota no-print">Cancelado el ${fmtFecha(r.fechaCancelacion)}${r.motivoCancelacion ? ' · Motivo: ' + esc(r.motivoCancelacion) : ''}</p>` : ''}` : ''}
      <div class="firma">${q.firma ? `<img class="firma-img" src="${q.firma}" alt="Firma">` : ''}${r.uuid ? `<small class="uuid">${esc(r.uuid)}</small>` : ''}<div class="linea"></div>
        ${q.nombre ? `<b>${esc(q.nombre)}</b>` : ''}${q.cargo ? `<small>${esc(q.cargo)}</small>` : ''}<span>Recibió</span></div>
    </div>
    <div class="acciones no-print">
      <button class="btn" data-act="print">Imprimir / PDF</button>
      <button class="btn wa" data-act="compartirRecibo" data-id="${r.id}">💬 Enviar por WhatsApp</button>
      ${r.cancelado ? '' : `<button class="btn danger" data-act="cancelarRecibo" data-id="${r.id}">Cancelar recibo</button>`}
      <button class="btn primary" data-act="close">Cerrar</button>
    </div>`);
  prepararImagenRecibo(r).catch(() => { reciboImg = null; });
}

/* ---- Consulta por folio ---- */
function buscarFolio() {
  openModal(`<form><h2>Consultar recibo por folio</h2>
    ${fld('Número de folio', 'folio', '', 'type="number" min="1" step="1" inputmode="numeric" required autofocus')}
    <div class="acciones"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Buscar</button></div>
  </form>`, async d => {
    const n = parseInt(d.folio, 10);
    const r = (await all('recibos')).find(r => r.folio === n);
    if (!r) { toast(`No existe el folio ${folioTxt(n || 0)}`); return false; }
    return () => verRecibo(r.id);
  });
}

/* ---- Cancelación: regresa el importe al adeudo del ingreso; el folio queda cancelado (no se reutiliza) ---- */
async function cancelarRecibo(id) {
  const r = await get('recibos', id);
  if (!r || r.cancelado) return;
  const i = r.ingresoId ? await get('ingresos', r.ingresoId) : null;
  openModal(`<form><h2>Cancelar recibo ${folioTxt(r.folio)}</h2>
    <p>${esc(r.nombre)} · ${esc(r.concepto)} · ${fmtFecha(r.fecha)}<br>Importe: <b>${money(r.importe)}</b></p>
    <p class="nota">${i ? `El importe regresará al adeudo: el ingreso quedará con <b>${txtAdeudo(round2(adeudoDe(i) + r.importe))}</b>.` : 'El ingreso de este recibo ya no existe; solo se marcará como cancelado.'}
      El folio ${folioTxt(r.folio)} quedará CANCELADO y no se volverá a usar. Esta acción no se puede deshacer.</p>
    ${fld('Motivo de la cancelación (opcional)', 'motivo', '')}
    <div class="acciones"><button type="button" class="btn" data-act="close">No cancelar</button><button class="btn danger">Cancelar recibo</button></div>
  </form>`, async d => {
    if (i) {
      i.aportacion = Math.max(0, round2(i.aportacion - r.importe));
      i.adeudo = adeudoDe(i);
      const k = (i.abonos || []).findIndex(a => a.fecha === r.fecha && round2(a.monto) === round2(r.importe));
      if (k >= 0) i.abonos.splice(k, 1);
      await put('ingresos', i);
    }
    Object.assign(r, { cancelado: true, fechaCancelacion: hoy(), motivoCancelacion: d.motivo.trim() });
    await put('recibos', r);
    toast(`Recibo ${folioTxt(r.folio)} cancelado · importe regresado al adeudo`);
    return () => verRecibo(r.id);
  });
}

/* ---- Recibo como imagen (PNG) ---- */
// Ajusta el texto al ancho disponible: reduce la letra y, si no cabe, lo corta con "…".
function fitText(ctx, text, maxW, size, weight = '', min = 11) {
  text = String(text ?? '');
  for (let s = size; s >= min; s--) {
    ctx.font = `${weight} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    if (ctx.measureText(text).width <= maxW) return text;
  }
  while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}

async function reciboCanvas(r) {
  const q = quienRecibe(r), W = 600, P = 32, ESC = 2;
  let firma = null;
  if (q.firma) { firma = new Image(); firma.src = q.firma; try { await firma.decode(); } catch { firma = null; } }
  const filas = [
    ['Fecha', fmtFecha(r.fecha)], ['Recibí de', r.nombre], ['Casa', r.casa], ['Concepto', r.concepto],
    ['Cantidad a aportar', money(r.cantidad)], ['Importe recibido', money(r.importe), 'grande'],
    [r.adeudo < 0 ? 'Saldo a favor' : 'Adeudo', money(Math.abs(r.adeudo)), r.adeudo > 0 ? 'neg' : r.adeudo < 0 ? 'pos' : ''],
  ];
  const altoFirma = firma ? 90 : 50;
  const altoUUID = r.uuid ? 20 : 0;
  const H = P + 96 + filas.length * 40 + 24 + altoFirma + altoUUID + 76 + P;
  const c = document.createElement('canvas');
  c.width = W * ESC; c.height = H * ESC;
  const x = c.getContext('2d');
  x.scale(ESC, ESC);
  const C = { tinta: '#1d2523', gris: '#66726e', linea: '#cfd8d4', pri: '#1f6f5c', pos: '#1b7f4b', neg: '#c0392b' };

  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.strokeStyle = C.pri; x.lineWidth = 3;
  x.beginPath(); x.roundRect(10, 10, W - 20, H - 20, 14); x.stroke();

  // Encabezado
  let y = P + 20;
  x.textBaseline = 'alphabetic'; x.textAlign = 'left'; x.fillStyle = C.tinta;
  x.fillText(fitText(x, cfg.org, W - 2 * P - 150, 22, 'bold'), P, y);
  x.fillStyle = C.gris; x.font = '13px system-ui, sans-serif';
  x.fillText('R E C I B O   D E   I N G R E S O', P, y + 26);
  x.textAlign = 'right';
  x.fillText('Folio', W - P, y - 2);
  x.fillStyle = C.neg; x.font = 'bold 26px system-ui, sans-serif';
  x.fillText(folioTxt(r.folio), W - P, y + 28);
  y += 50;
  x.setLineDash([5, 4]); x.strokeStyle = C.linea; x.lineWidth = 1;
  x.beginPath(); x.moveTo(P, y); x.lineTo(W - P, y); x.stroke(); x.setLineDash([]);

  // Filas
  y += 34;
  for (const [et, val, cls] of filas) {
    x.textAlign = 'left'; x.fillStyle = C.gris; x.font = '15px system-ui, sans-serif';
    x.fillText(et, P, y);
    const anchoEt = x.measureText(et).width + 16;
    x.textAlign = 'right'; x.fillStyle = cls === 'grande' ? C.pos : cls === 'neg' ? C.neg : cls === 'pos' ? C.pos : C.tinta;
    x.fillText(fitText(x, val, W - 2 * P - anchoEt, cls === 'grande' ? 24 : 17, 'bold'), W - P, y);
    y += 40;
  }

  // Firma
  y += 24;
  const lineaY = y + altoFirma + altoUUID - 10;
  if (firma) {
    const s = Math.min(280 / firma.width, 84 / firma.height, 1.6);
    const fw = firma.width * s, fh = firma.height * s;
    x.drawImage(firma, (W - fw) / 2, lineaY - altoUUID - fh + 8, fw, fh);
  }
  // UUID justo encima de la línea de firma
  if (r.uuid) { x.textAlign = 'center'; x.fillStyle = C.gris; x.fillText(fitText(x, r.uuid, W - 2 * P, 12, '', 9), W / 2, lineaY - 6); }
  x.strokeStyle = C.tinta; x.lineWidth = 1;
  x.beginPath(); x.moveTo(W * 0.2, lineaY); x.lineTo(W * 0.8, lineaY); x.stroke();
  x.textAlign = 'center'; y = lineaY + 22;
  if (q.nombre) { x.fillStyle = C.tinta; x.fillText(fitText(x, q.nombre, W - 2 * P, 16, 'bold'), W / 2, y); y += 20; }
  x.fillStyle = C.gris; x.font = '13px system-ui, sans-serif';
  if (q.cargo) { x.fillText(q.cargo, W / 2, y); y += 18; }
  x.fillText('Recibió', W / 2, y);

  if (r.cancelado) {
    x.save(); x.translate(W / 2, H / 2); x.rotate(-0.3);
    x.globalAlpha = 0.55; x.strokeStyle = x.fillStyle = C.neg; x.lineWidth = 5;
    x.font = 'bold 54px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    const tw = x.measureText('CANCELADO').width;
    x.strokeRect(-tw / 2 - 18, -40, tw + 36, 80); x.fillText('CANCELADO', 0, 2);
    x.restore();
  }
  return c;
}

// Se prepara al abrir el recibo para que "Compartir" abra el menú al instante
// (algunos navegadores, como Safari, lo bloquean si pasa mucho tiempo tras tocar el botón).
let reciboImg = null; // { id, file }
async function prepararImagenRecibo(r) {
  reciboImg = null;
  const c = await reciboCanvas(r);
  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  reciboImg = { id: r.id, file: new File([blob], `recibo-${folioTxt(r.folio)}.png`, { type: 'image/png' }) };
}

async function compartirRecibo(id) {
  if (reciboImg?.id !== id) { toast('Preparando imagen…'); await prepararImagenRecibo(await get('recibos', id)); }
  const { file } = reciboImg;
  if (navigator.canShare?.({ files: [file] })) {
    // Solo el archivo: sin título ni texto, para que WhatsApp envíe únicamente la imagen.
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  // Sin soporte para compartir archivos (p. ej. en PC): se descarga la imagen.
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast('Imagen del recibo descargada');
}

/* ================= Firma digital ================= */
const TINTA = [26, 42, 108]; // azul tinta
const prevFirma = () => firmaUrl(cfg.firmaId) ? `<img src="${firmaUrl(cfg.firmaId)}" alt="Firma">` : '<span class="nota">Sin firma</span>';
let padCtx = null, padUltimo = null;

function abrirPad(img) {
  $('#padDlg').showModal();
  const c = $('#pad'), dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = Math.round(Math.min(w * 0.5, window.innerHeight * 0.5));
  c.style.height = h + 'px'; c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  padCtx = c.getContext('2d');
  padCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  Object.assign(padCtx, { lineWidth: 2.6, lineCap: 'round', lineJoin: 'round', strokeStyle: `rgb(${TINTA})`, fillStyle: `rgb(${TINTA})` });
  if (img) {
    // Ajusta la foto al recuadro y deja solo el trazo: lo claro se vuelve transparente, lo oscuro color tinta.
    const s = Math.min(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
    padCtx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    const im = padCtx.getImageData(0, 0, c.width, c.height), d = im.data;
    let tot = 0, n = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k + 3]) { tot += d[k] * .299 + d[k + 1] * .587 + d[k + 2] * .114; n++; }
    const umbral = (tot / (n || 1)) * 0.72;
    for (let k = 0; k < d.length; k += 4) {
      const lum = d[k] * .299 + d[k + 1] * .587 + d[k + 2] * .114;
      if (!d[k + 3] || lum > umbral) d[k + 3] = 0;
      else { [d[k], d[k + 1], d[k + 2]] = TINTA; d[k + 3] = 255; }
    }
    padCtx.putImageData(im, 0, 0);
  }
}

(() => {
  const c = $('#pad');
  const pos = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener('pointerdown', e => {
    c.setPointerCapture(e.pointerId); padUltimo = pos(e);
    padCtx.beginPath(); padCtx.arc(padUltimo[0], padUltimo[1], 1.3, 0, 7); padCtx.fill();
  });
  c.addEventListener('pointermove', e => {
    if (!padUltimo) return;
    const p = pos(e);
    padCtx.beginPath(); padCtx.moveTo(...padUltimo); padCtx.lineTo(...p); padCtx.stroke();
    padUltimo = p;
  });
  ['pointerup', 'pointercancel'].forEach(t => c.addEventListener(t, () => { padUltimo = null; }));
})();

// Recorta la firma a su contenido y la devuelve como PNG transparente (máx. 600 px de ancho).
function exportarFirma() {
  const c = $('#pad'), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (d[(y * W + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const m = 10; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, sc = Math.min(1, 600 / cw);
  const out = document.createElement('canvas');
  out.width = Math.round(cw * sc); out.height = Math.round(ch * sc);
  out.getContext('2d').drawImage(c, x0, y0, cw, ch, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

async function guardarFirma() {
  const url = exportarFirma();
  if (!url) { toast('Primero dibuja la firma'); return; }
  const id = Date.now().toString(36);
  await setCfg('firma_' + id, url);
  await setCfg('firmaId', id);
  $('#padDlg').close();
  const prev = $('#firmaPrev'); if (prev) prev.innerHTML = prevFirma();
  toast('Firma guardada');
}

function firmaFoto() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const img = new Image();
    img.onload = () => { abrirPad(img); URL.revokeObjectURL(img.src); toast('Revisa la firma y toca Guardar'); };
    img.onerror = () => alert('No se pudo leer la imagen.');
    img.src = URL.createObjectURL(file);
  };
  inp.click();
}

async function firmaQuitar() {
  if (!cfg.firmaId || !confirm('¿Quitar la firma? Los recibos nuevos saldrán sin firma (los ya emitidos la conservan).')) return;
  await setCfg('firmaId', '');
  $('#firmaPrev').innerHTML = prevFirma();
  toast('Firma quitada');
}

/* ================= Configuración y respaldo ================= */
const rowTipo = t => `<div class="tipo-row">
  <input name="tiNombre" value="${esc(t.nombre)}" placeholder="Tipo de ingreso" aria-label="Tipo de ingreso">
  <input name="tiCantidad" type="number" step="0.01" min="0" inputmode="decimal" value="${+t.cantidad || ''}" placeholder="Variable" aria-label="Cantidad a aportar">
  <button type="button" class="btn" data-act="delRow" aria-label="Quitar">✕</button></div>`;
function formConfig() {
  openModal(`<form><h2>Configuración</h2>
    ${fld('Nombre de la asociación (aparece en los recibos)', 'org', cfg.org, 'required')}
    <div class="row2">${fld('Persona que recibe (firma del recibo)', 'recibe', cfg.recibe, 'placeholder="Nombre completo"')}${fld('Cargo', 'cargoRecibe', cfg.cargoRecibe, 'placeholder="Tesorero(a)"')}</div>
    <label>Firma de quien recibe</label>
    <div class="firma-cfg"><div id="firmaPrev">${prevFirma()}</div>
      <div class="botones">
        <button type="button" class="btn" data-act="firmaDibujar">✍ Dibujar firma</button>
        <button type="button" class="btn" data-act="firmaFoto">📷 Subir foto</button>
        <button type="button" class="btn" data-act="firmaQuitar">Quitar</button>
      </div></div>
    <label>Tipos de ingreso y cantidad a aportar</label>
    <p class="nota">Deja la cantidad vacía si el monto es variable (se capturará en cada ingreso).</p>
    <div id="tiposIng">${cfg.tiposIngreso.map(rowTipo).join('')}</div>
    <button type="button" class="btn" data-act="addTipoIng">+ Agregar tipo de ingreso</button>
    <div style="height:12px"></div>
    <label>Tipos de gasto (uno por línea)<textarea name="tiposGasto" rows="6">${esc(cfg.tiposGasto.join('\n'))}</textarea></label>
    ${fld('Último folio emitido (el siguiente recibo usará este + 1)', 'folio', cfg.folio, 'type="number" min="0" step="1" required')}
    <div class="acciones"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>
    <h3>Respaldo de datos</h3>
    <p class="nota">La información se guarda únicamente en este dispositivo. Descarga un respaldo con frecuencia y guárdalo en Drive, correo o WhatsApp.
      Último respaldo: <b>${cfg.ultimoRespaldo ? fmtFecha(cfg.ultimoRespaldo) : 'nunca'}</b>. Si pasan más de ${DIAS_RESPALDO} días, Inicio mostrará un aviso.</p>
    <div class="botones">
      <button type="button" class="btn" data-act="exportJSON">⬇ Descargar respaldo</button>
      <button type="button" class="btn" data-act="importJSON">⬆ Restaurar respaldo</button>
    </div>
    <h3>Exportar a Excel (CSV)</h3>
    <div class="botones">${['personas', 'ingresos', 'gastos', 'recibos'].map(s => `<button type="button" class="btn" data-act="exportCSV" data-id="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
  </form>`, async (d, f) => {
    const lines = s => [...new Set(s.split('\n').map(x => x.trim()).filter(Boolean))];
    const fd = new FormData(f), noms = fd.getAll('tiNombre'), cants = fd.getAll('tiCantidad'), vistos = new Set(), ti = [];
    noms.forEach((n, k) => { n = n.trim(); if (n && !vistos.has(n)) { vistos.add(n); ti.push({ nombre: n, cantidad: round2(cants[k]) }); } });
    const tg = lines(d.tiposGasto);
    if (!ti.length || !tg.length) { toast('Debe haber al menos un tipo de ingreso y uno de gasto'); return false; }
    await setCfg('org', d.org.trim());
    await setCfg('recibe', d.recibe.trim());
    await setCfg('cargoRecibe', d.cargoRecibe.trim());
    await setCfg('tiposIngreso', ti);
    await setCfg('tiposGasto', tg);
    await setCfg('folio', Math.max(0, parseInt(d.folio, 10) || 0));
    toast('Configuración guardada');
  });
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

async function exportJSON() {
  const data = { app: 'CGI', version: 1, exportado: new Date().toISOString() };
  await setCfg('ultimoRespaldo', hoy());
  for (const s of STORES) data[s] = await all(s);
  download(`respaldo-cgi-${hoy()}.json`, JSON.stringify(data, null, 1), 'application/json');
  toast('Respaldo descargado · guárdalo en Drive, correo o USB');
  if (state.view === 'inicio') renderList();
}

function importJSON() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.app !== 'CGI' || !Array.isArray(data.personas)) throw new Error('El archivo no es un respaldo de esta aplicación.');
      if (!confirm('Esto REEMPLAZARÁ todos los datos actuales con los del respaldo. ¿Continuar?')) return;
      await tx(STORES, 'readwrite', t => {
        for (const s of STORES) { const st = t.objectStore(s); st.clear(); (data[s] || []).forEach(o => st.put(o)); }
      });
      await loadConfig(); await asegurarUUIDs(); await setCfg('ultimoRespaldo', hoy()); // los datos ahora coinciden con un archivo de respaldo
      closeModal(); toast('Respaldo restaurado'); render();
    } catch (e) { alert('No se pudo restaurar: ' + e.message); }
  };
  inp.click();
}

async function exportCSV(s) {
  const [rows, per, ing] = await Promise.all([all(s), all('personas'), all('ingresos')]);
  const pm = mapById(per);
  const ingresosDe = pid => ing.filter(i => i.personaId === pid);
  if (s === 'personas') rows.sort(cmpCasa);
  const defs = {
    personas: [['Casa', 'numCasa'], ['Nombre', 'nombre'], ['Apellido paterno', 'apPaterno'], ['Apellido materno', 'apMaterno'], ['Tipo', 'tipo'], ['Género', 'genero'], ['Teléfono', 'telefono'], ['Email', 'email'], ['Activo', p => esActiva(p) ? 'Sí' : 'No'],
      ['Concepto del adeudo', p => Object.entries((adeudosPorPersona(ingresosDe(p.id), '')[p.id] || SIN_INFO).porTipo).map(([t, v]) => `${t} ${round2(v)}`).join('; ')],
      ['Adeudo', p => sum(ingresosDe(p.id), deuda)]],
    ingresos: [['Fecha', 'fecha'], ['Casa', r => pm[r.personaId]?.numCasa], ['Persona', r => nombreCompleto(pm[r.personaId])], ['Tipo', 'tipo'], ['Cantidad a aportar', 'cantidad'], ['Aportación', 'aportacion'], ['Adeudo', adeudoDe], ['Nota', 'nota']],
    gastos: [['Fecha', 'fecha'], ['Tipo de gasto', 'tipo'], ['Importe', 'importe'], ['Descripción', 'descripcion']],
    recibos: [['Folio', r => folioTxt(r.folio)], ['UUID', 'uuid'], ['Fecha', 'fecha'], ['Nombre', 'nombre'], ['Casa', 'casa'], ['Concepto', 'concepto'], ['Importe recibido', 'importe'], ['Adeudo', 'adeudo'], ['Recibió', r => quienRecibe(r).nombre], ['Cargo', r => quienRecibe(r).cargo], ['Cancelado', r => r.cancelado ? 'Sí' : ''], ['Fecha cancelación', 'fechaCancelacion'], ['Motivo cancelación', 'motivoCancelacion']],
  }[s];
  const cell = v => { v = String(v ?? ''); return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csv = '﻿' + [defs.map(c => c[0]).join(','), ...rows.map(r => defs.map(([, f]) => cell(typeof f === 'function' ? f(r) : r[f])).join(','))].join('\r\n');
  download(`${s}-${hoy()}.csv`, csv, 'text/csv;charset=utf-8');
}

/* ================= Eventos ================= */
const ACT = {
  close: closeModal,
  config: formConfig,
  estadoPago: v => { state.estadoPago = v || ''; render(); },
  todoPeriodo: () => { state.mes = state.mes ? '' : hoy().slice(0, 7); render(); },
  verPersona: async id => formPersona(await get('personas', id)),
  editIngreso: async id => formIngreso(await get('ingresos', id)),
  editGasto: async id => formGasto(await get('gastos', id)),
  delPersona, delIngreso, delGasto, abonar, verRecibo, compartirRecibo, listadoPersonas, buscarFolio, cancelarRecibo, generarCuentas,
  print: () => window.print(),
  addTipoIng: () => { $('#tiposIng').insertAdjacentHTML('beforeend', rowTipo({ nombre: '', cantidad: 0 })); $('#tiposIng .tipo-row:last-child input').focus(); },
  delRow: (_, el) => el.closest('.tipo-row').remove(),
  firmaDibujar: () => abrirPad(), firmaFoto, firmaQuitar,
  padLimpiar: () => { const c = $('#pad'); padCtx.clearRect(0, 0, c.width, c.height); },
  padCerrar: () => $('#padDlg').close(),
  padGuardar: guardarFirma,
  exportJSON, importJSON, exportCSV,
  posponerRespaldo: async () => { await setCfg('respaldoPospuesto', hoy()); renderList(); },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  const raw = el.dataset.id;
  ACT[el.dataset.act]?.(raw && /^\d+$/.test(raw) ? Number(raw) : raw, el);
});
const onFilter = e => {
  const f = e.target.dataset.filter;
  if (!f || (f === 'mes') !== (e.type === 'change')) return;
  state[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  f === 'mes' ? render() : renderList();
};
$('#view').addEventListener('input', onFilter);
$('#view').addEventListener('change', onFilter);
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
$('#fab').addEventListener('click', () => VIEWS[state.view].fab?.());

/* ================= Inicio de la app ================= */
(async () => {
  try {
    await dbReady;
    await loadConfig();
    await asegurarUUIDs();
    navigator.storage?.persist?.();
    await render();
  } catch (e) {
    $('#view').innerHTML = vacio('Error al abrir la base de datos: ' + esc(e.message));
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js');
})();
