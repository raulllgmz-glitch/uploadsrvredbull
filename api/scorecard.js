// Vercel Serverless Function
// GET /api/scorecard
// Consulta Airtable (SERVICIOS de la base RED BULL SRV), filtra a servicios
// concluidos desde la fecha base, y regresa un arreglo compacto listo para
// que el dashboard lo consuma. El token de Airtable vive SOLO aquí (variable
// de entorno en Vercel), nunca llega al navegador del cliente.

const BASE_ID = 'appPlF7o7MQwlMqh7';
const TABLE_ID = 'tbl6DzGnG5qzrgFKB'; // SERVICIOS
const CODING_TABLE_ID = 'tbl8DurSaV3CBOO9S'; // CODING (catálogo de LATE REASON CODE)
const BASELINE_DATE = '2026-02-28';

const FIELDS = ['FOLIO', 'TIPO DE SERVICIO', 'FECHA CIERRE', 'TR_WORKDAYS', 'TR_STATUS', 'CHARGABLE-NON', 'ESTADO1', 'REASON CODING LATE'];

async function fetchCodingMap(token) {
  // La tabla CODING es el catálogo de motivos de late (LATE REASON CODE).
  // SERVICIOS solo guarda el link (record id) a esta tabla, así que resolvemos
  // el texto aquí una vez y lo usamos como diccionario id -> código.
  const qs = new URLSearchParams();
  qs.append('fields[]', 'LATE REASON CODE');
  const map = {};
  let offset;
  do {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${CODING_TABLE_ID}?${qs.toString()}${offset ? '&offset=' + offset : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Airtable (CODING) respondió ${r.status}: ${text.slice(0, 300)}`);
    }
    const data = await r.json();
    for (const rec of data.records || []) {
      map[rec.id] = (rec.fields || {})['LATE REASON CODE'] || null;
    }
    offset = data.offset;
  } while (offset);
  return map;
}

module.exports = async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'Falta configurar la variable de entorno AIRTABLE_TOKEN en Vercel.' });
    return;
  }

  const filterByFormula = `AND(FIND("CONCLUDED SERVICES", ARRAYJOIN({STATUS SCORECARD})) > 0, NOT(IS_BEFORE({FECHA CIERRE}, "${BASELINE_DATE}")))`;

  const qs = new URLSearchParams();
  qs.set('filterByFormula', filterByFormula);
  qs.set('pageSize', '100');
  FIELDS.forEach(f => qs.append('fields[]', f));
  qs.append('fields[]', 'STATUS SCORECARD');

  let offset = undefined;
  const out = [];

  try {
    const codingMap = await fetchCodingMap(token);

    do {
      const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?${qs.toString()}${offset ? '&offset=' + offset : ''}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`Airtable respondió ${r.status}: ${text.slice(0, 300)}`);
      }
      const data = await r.json();

      for (const rec of data.records || []) {
        const f = rec.fields || {};
        const folio = f['FOLIO'] || rec.id;
        const tipo = f['TIPO DE SERVICIO'] || '';
        const fecha = f['FECHA CIERRE'] || '';
        const tr = typeof f['TR_WORKDAYS'] === 'number' ? f['TR_WORKDAYS'] : null;
        const trStatus = f['TR_STATUS'] || '';
        let chargable = f['CHARGABLE-NON'];
        if (Array.isArray(chargable)) chargable = chargable[0];
        if (chargable && typeof chargable === 'object' && chargable.name) chargable = chargable.name;
        const estado = f['ESTADO1'] || null;
        const reasonLinks = f['REASON CODING LATE'];
        const reasonCode = (Array.isArray(reasonLinks) && reasonLinks.length) ? (codingMap[reasonLinks[0]] || null) : null;
        if (!fecha) continue;
        out.push([folio, tipo, fecha, tr, trStatus, chargable || null, estado, reasonCode]);
      }
      offset = data.offset;
    } while (offset);

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(200).json({ records: out, fetchedAt: new Date().toISOString(), count: out.length });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo leer Airtable: ' + err.message });
  }
};
