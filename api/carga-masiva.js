// Vercel Serverless Function
// POST /api/carga-masiva
// Recibe filas desde la página de carga masiva (pensada para abrirse como Webview
// dentro de Glide, donde el usuario NUNCA ve Airtable) y crea los servicios
// directo en la tabla SERVICIOS de la base RED BULL SRV. Valida TIPO DE SERVICIO,
// USERS y ESTADO contra los catálogos reales antes de crear nada; si alguno no
// coincide, regresa el error para esa fila sin tocar Airtable.
//
// El token de Airtable vive SOLO aquí (variable de entorno AIRTABLE_TOKEN en
// Vercel) y necesita permiso de escritura (data.records:write) sobre esta base,
// además del de lectura que ya usa el scorecard.

const BASE_ID = 'appPlF7o7MQwlMqh7';
const SERVICIOS_TABLE_ID = 'tbl6DzGnG5qzrgFKB';
const TIPO_TABLE_ID = 'tblL1TITh8kG3eyiD';
const ESTADOS_TABLE_ID = 'tblSMjsu4xPFqLV0r';
const USERS_TABLE_ID = 'tbly620SsIM6V62xu';

const STATUS_ABIERTA_RECORD_ID = 'recNpysMcSvjZ8TRf'; // STATUS = 🟣 ABIERTA

// Campos de SERVICIOS que esta función escribe
const F = {
  STATUS: 'fldhCXl7BJzqL3UBN',
  TIPO_TEXTO: 'fldXbnYeBRhda7FpS',
  POS_SUCURSAL: 'fldOdVMmBqGROY7FJ',
  POS_CONTACTO: 'fldotnmqrmdYwWGLg',
  POS_CONTACTO_TEL: 'fld56bDBELBU9npD8',
  POS_LINK_URL: 'fld2GwlMCtzohYwKf',
  MATERIAL: 'fldVECOsxildo6Eeu',
  SERIE: 'fldh24bSQhCoCtS0f',
  ESTADO: 'fld5GmisJnqEwT13P',
  USERS: 'fldNAIGHsE8kW4xYk',
  FOLIO: 'fldwFptMJflwLvJss', // campo formula, solo para leerlo de vuelta
  CONFIRMADO: 'fldDbu8skkjaWjFuz',
  CARGA_MASIVA_WEB: 'fldIu6hDbpLUQccJ7', // marca el origen y evita que SEND_CREACIÓN_CORREO / SEND_AUTORIZACIÓN_TRADE disparen un correo por cada fila
  FECHA_CREACION: 'fldPTefhwXHESoiif', // ninguna automatización la llena sola; la usan las fórmulas de on-time/atraso
};

const TIPO_NAME_FIELD = 'fldApgNVNsQ2nSeEQ';
const ESTADO_NAME_FIELD = 'fldCQvV00DwZLvdp6';
const USERS_NAME_FIELD = 'fldb4sWyN2cRtV0ze';
const USERS_EMAIL_FIELD = 'fldEu9urlZwi1olBC';

const MAX_ROWS = 200;

function norm(s) {
  return (s || '').toString().trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function fetchAll(token, tableId, fieldIds) {
  const qs = new URLSearchParams();
  fieldIds.forEach((f) => qs.append('fields[]', f));
  qs.set('pageSize', '100');
  qs.set('returnFieldsByFieldId', 'true');
  const out = [];
  let offset;
  do {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${tableId}?${qs.toString()}${offset ? '&offset=' + offset : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Airtable (${tableId}) respondió ${r.status}: ${text.slice(0, 300)}`);
    }
    const data = await r.json();
    out.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return out;
}

function findTipo(tipoRecs, input) {
  const i = norm(input);
  if (!i) return null;
  return (
    tipoRecs.find((r) => {
      const n = norm(r.fields[TIPO_NAME_FIELD]);
      return n === i || n.indexOf(i) === 0 || i.indexOf(n) === 0;
    }) || null
  );
}

function findEstado(estadoRecs, input) {
  const i = norm(input);
  if (!i) return null;
  return estadoRecs.find((r) => norm(r.fields[ESTADO_NAME_FIELD]) === i) || null;
}

function findUser(userRecs, input) {
  const i = norm(input);
  if (!i) return null;
  return (
    userRecs.find((r) => {
      const nombre = norm(r.fields[USERS_NAME_FIELD]);
      const email = norm(r.fields[USERS_EMAIL_FIELD]);
      return (nombre && nombre === i) || (email && email === i);
    }) || null
  );
}

async function createServiciosBatch(token, records) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${SERVICIOS_TABLE_ID}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records, typecast: false, returnFieldsByFieldId: true }),
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error((data && data.error && data.error.message) || `Airtable respondió ${r.status}`);
  }
  return data.records;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Usa POST.' });
    return;
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'Falta configurar AIRTABLE_TOKEN en Vercel (con permiso de escritura).' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: 'JSON inválido.' });
    return;
  }

  const inputRows = Array.isArray(body && body.rows) ? body.rows : [];
  if (inputRows.length === 0) {
    res.status(400).json({ error: 'No se recibieron filas.' });
    return;
  }
  if (inputRows.length > MAX_ROWS) {
    res.status(400).json({ error: `Máximo ${MAX_ROWS} filas por carga.` });
    return;
  }

  try {
    const [tipoRecs, estadoRecs, userRecs] = await Promise.all([
      fetchAll(token, TIPO_TABLE_ID, [TIPO_NAME_FIELD]),
      fetchAll(token, ESTADOS_TABLE_ID, [ESTADO_NAME_FIELD]),
      fetchAll(token, USERS_TABLE_ID, [USERS_NAME_FIELD, USERS_EMAIL_FIELD]),
    ]);

    // 1) validar cada fila
    const prepared = inputRows.map((row) => {
      const tipoMatch = findTipo(tipoRecs, row.tipo);
      const userMatch = row.solicitante ? findUser(userRecs, row.solicitante) : null;
      const estadoMatch = row.estado ? findEstado(estadoRecs, row.estado) : null;

      const errores = [];
      if (!row.tipo) {
        errores.push('Falta TIPO DE SERVICIO.');
      } else if (!tipoMatch) {
        errores.push(`TIPO DE SERVICIO "${row.tipo}" no reconocido (usa INSTALACIÓN, REPARACIÓN, RETIRO o TRASLADO).`);
      }
      if (row.solicitante && !userMatch) {
        errores.push(`USERS "${row.solicitante}" no encontrado (debe coincidir con Nombre o Email exacto).`);
      }
      if (row.estado && !estadoMatch) {
        errores.push(`ESTADO "${row.estado}" no coincide con el catálogo de estados.`);
      }

      return { id: row.id, row, tipoMatch, userMatch, estadoMatch, errores };
    });

    const toCreate = prepared.filter((p) => p.errores.length === 0);
    const results = prepared
      .filter((p) => p.errores.length > 0)
      .map((p) => ({ id: p.id, ok: false, error: p.errores.join(' | ') }));

    // 2) crear en lotes de 10 (límite de la API de Airtable) y mapear resultados de vuelta
    for (let i = 0; i < toCreate.length; i += 10) {
      const chunk = toCreate.slice(i, i + 10);
      const records = chunk.map((p) => {
        const fields = {
          [F.STATUS]: [STATUS_ABIERTA_RECORD_ID],
          [F.TIPO_TEXTO]: p.tipoMatch.fields[TIPO_NAME_FIELD],
          [F.POS_SUCURSAL]: p.row.posSucursal || '',
          [F.POS_CONTACTO]: p.row.posContacto || '',
          [F.POS_CONTACTO_TEL]: p.row.posContactoTel || '',
          [F.POS_LINK_URL]: p.row.posLinkUrl || '',
          [F.MATERIAL]: p.row.material || '',
          [F.SERIE]: p.row.serie || '',
          [F.CONFIRMADO]: new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }),
          [F.CARGA_MASIVA_WEB]: true,
          [F.FECHA_CREACION]: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }), // YYYY-MM-DD
        };
        if (p.userMatch) fields[F.USERS] = [p.userMatch.id];
        if (p.estadoMatch) fields[F.ESTADO] = [p.estadoMatch.id];
        return { fields };
      });

      try {
        const created = await createServiciosBatch(token, records);
        created.forEach((rec, idx) => {
          results.push({ id: chunk[idx].id, ok: true, folio: (rec.fields && rec.fields[F.FOLIO]) || rec.id });
        });
      } catch (err) {
        chunk.forEach((p) => {
          results.push({ id: p.id, ok: false, error: 'No se pudo crear en Airtable: ' + err.message });
        });
      }
    }

    res.status(200).json({ results });
  } catch (err) {
    res.status(502).json({ error: 'No se pudo leer Airtable: ' + err.message });
  }
};
