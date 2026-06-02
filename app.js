const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== MIDDLEWARES GLOBALES ==========
app.use(express.json({ limit: '50kb' }));           // Limita tamaño de payloads
app.use(express.static('public'));

// Cabeceras de seguridad básicas
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ========== BASE DE DATOS ==========
const DB_PATH = process.env.DB_PATH || './database.db';
const db = new sqlite3.Database(DB_PATH)

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    is_admin INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    date TEXT,
    home TEXT,
    away TEXT,
    stage TEXT,
    match_datetime TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    match_id TEXT,
    vote TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, match_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS results (
    match_id TEXT PRIMARY KEY,
    result TEXT
  )`);
});

// ========== VALIDADORES ==========

/**
 * Sanitiza un string para uso general (sin HTML ni scripts).
 * No reemplaza caracteres; simplemente rechaza si contiene patrones peligrosos.
 */
function sanitizeText(str, maxLen = 100) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim().substring(0, maxLen);
  // Rechaza si contiene etiquetas HTML / scripts
  if (/<[^>]*>|javascript:/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Valida un nombre de usuario:
 * - 2–30 caracteres
 * - Solo letras, números, guiones, guiones bajos y puntos
 */
function validarNombreUsuario(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  return /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ0-9._\- ]{2,30}$/.test(n);
}

/**
 * Contraseña mínima: 8 caracteres.
 */
function validarPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128;
}

// ========== CREAR ADMIN POR DEFECTO ==========
// ⚠️  IMPORTANTE: Cambia la contraseña del admin desde el panel de administración
//     inmediatamente después del primer inicio de sesión.
const ADMIN_DEFAULT_PASS = process.env.ADMIN_DEFAULT_PASS || 'CambiaEsto2026!';

const crearAdminPorDefecto = async () => {
  db.get("SELECT id FROM users WHERE name = ?", ["admin"], async (err, row) => {
    if (!row) {
      const hash = await bcrypt.hash(ADMIN_DEFAULT_PASS, 12); // cost factor 12
      db.run("INSERT INTO users (name, password, is_admin) VALUES (?, ?, ?)",
        ["admin", hash, 1]);
      console.log("✅ Admin creado. Contraseña por variable ADMIN_DEFAULT_PASS o 'CambiaEsto2026!'");
      console.log("⚠️  Cambia la contraseña desde el panel de administración tras el primer login.");
    }
  });
};

// ========== CARGAR PARTIDOS ==========
async function cargarPartidosDesdeAPI() {
  return new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as count FROM matches", async (err, row) => {
      if (err) return reject(err);
      if (row.count > 0) {
        console.log("✅ Los partidos ya existen en la BD.");
        return resolve();
      }
      console.log("🌐 Descargando calendario del Mundial 2026...");
      try {
        const respuesta = await fetch('https://cdn.jsdelivr.net/gh/openfootball/worldcup.json@master/2026/worldcup.json');
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
        const datos = await respuesta.json();
        const insert = db.prepare(`INSERT OR IGNORE INTO matches (id, date, home, away, stage, match_datetime) VALUES (?, ?, ?, ?, ?, ?)`);
        let count = 0;
        for (const partido of datos.matches) {
          const idPartido = `wc_${partido.date}_${partido.team1}_${partido.team2}`.replace(/\s/g, '_');
          const fechaHora = `${partido.date}T${partido.time?.split(' ')[0] || '12:00'}:00`;
          const fechaISO = new Date(fechaHora).toISOString();
          insert.run(idPartido, partido.date, partido.team1, partido.team2,
            partido.round || partido.group || "Fase de grupos", fechaISO);
          count++;
        }
        insert.finalize();
        console.log(`✅ Se cargaron ${count} partidos.`);
        resolve();
      } catch (error) {
        console.error("❌ Error cargando partidos:", error.message);
        reject(error);
      }
    });
  });
}

// ========== ACTUALIZAR RESULTADOS (API-Football) ==========
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '';  // Usa variable de entorno
const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const WORLD_CUP_LEAGUE_ID = 1;
const WORLD_CUP_SEASON = 2026;

async function actualizarResultadosAutomaticos() {
  if (!API_FOOTBALL_KEY) return; // No intentar sin clave
  console.log("🔄 Actualizando resultados desde API-Football...");
  try {
    const url = `https://${API_FOOTBALL_HOST}/fixtures?league=${WORLD_CUP_LEAGUE_ID}&season=${WORLD_CUP_SEASON}&status=FT`;
    const response = await fetch(url, {
      headers: { 'x-apisports-key': API_FOOTBALL_KEY }
    });
    const data = await response.json();
    if (!data.response) return;
    let actualizados = 0;
    for (const partido of data.response) {
      if (partido.fixture.status.short === 'FT') {
        let resultado = null;
        if (partido.goals.home > partido.goals.away) resultado = 'home';
        else if (partido.goals.home < partido.goals.away) resultado = 'away';
        else if (partido.goals.home === partido.goals.away) resultado = 'draw';
        if (resultado) {
          const matchId = partido.fixture.id.toString();
          db.run(`INSERT OR REPLACE INTO results (match_id, result) VALUES (?, ?)`, [matchId, resultado]);
          actualizados++;
        }
      }
    }
    console.log(`✅ Resultados actualizados: ${actualizados} partidos finalizados.`);
  } catch (error) {
    console.error("❌ Error actualizando resultados:", error.message);
  }
}

// ========== SESIONES EN MEMORIA ==========
const sesiones = {};

// Limpia sesiones huérfanas cada hora
setInterval(() => {
  const hace1h = Date.now() - 3600000;
  for (const [token, sesion] of Object.entries(sesiones)) {
    if (sesion.createdAt < hace1h) delete sesiones[token];
  }
}, 3600000);

function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const sesion = sesiones[token];
  if (!sesion) return res.status(401).json({ error: 'Sesión inválida o expirada' });
  req.userId = sesion.userId;
  req.isAdmin = sesion.isAdmin;
  next();
}

// ========== RUTAS DE AUTENTICACIÓN ==========

/**
 * POST /api/register
 * SOLO crea usuarios normales (isAdmin siempre false en registro público).
 * Para crear admins, usa el panel de administración.
 */
app.post('/api/register', async (req, res) => {
  const { name, password } = req.body;

  if (!validarNombreUsuario(name)) {
    return res.status(400).json({ error: 'Nombre inválido (2-30 caracteres, sin HTML)' });
  }
  if (!validarPassword(password)) {
    return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres' });
  }

  const safeName = name.trim();

  db.get("SELECT id FROM users WHERE LOWER(name) = LOWER(?)", [safeName], async (err, row) => {
    if (row) return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    const hash = await bcrypt.hash(password, 12);
    // isAdmin siempre false en registro público — ignora cualquier flag del cliente
    db.run("INSERT INTO users (name, password, is_admin) VALUES (?, ?, 0)",
      [safeName, hash], function (err) {
        if (err) return res.status(500).json({ error: 'Error al crear usuario' });
        res.json({ id: this.lastID, name: safeName, isAdmin: false });
      });
  });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password || typeof name !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  db.get("SELECT id, name, password, is_admin FROM users WHERE name = ?",
    [name.trim()], async (err, user) => {
      if (err || !user) return res.status(401).json({ error: 'Credenciales inválidas' });
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });
      const token = require('crypto').randomBytes(32).toString('hex');
      sesiones[token] = { userId: user.id, isAdmin: user.is_admin === 1, createdAt: Date.now() };
      res.json({ token, userId: user.id, name: user.name, isAdmin: user.is_admin === 1 });
    });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization;
  delete sesiones[token];
  res.json({ success: true });
});

// Resetear contraseña — solo admin, mínimo 8 caracteres
app.post('/api/users/reset-password', authMiddleware, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo administrador' });
  const { userId, newPassword } = req.body;
  if (!userId || !validarPassword(newPassword)) {
    return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  db.run("UPDATE users SET password = ? WHERE id = ?", [hash, userId], function (err) {
    if (err) return res.status(500).json({ error: 'Error al actualizar' });
    res.json({ success: true });
  });
});

// ========== RUTAS PROTEGIDAS ==========

app.get('/api/matches', authMiddleware, (req, res) => {
  db.all('SELECT * FROM matches ORDER BY match_datetime', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error al obtener partidos' });
    res.json(rows);
  });
});

app.post('/api/matches/datetime', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  const { matchId, datetime } = req.body;
  if (!matchId || !datetime || isNaN(Date.parse(datetime))) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  db.run("UPDATE matches SET match_datetime = ? WHERE id = ?", [datetime, matchId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/vote', authMiddleware, (req, res) => {
  const { matchId, vote } = req.body;
  if (!matchId || !['home', 'draw', 'away'].includes(vote)) {
    return res.status(400).json({ error: 'Voto inválido' });
  }
  db.get("SELECT match_datetime FROM matches WHERE id = ?", [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Partido no existe' });
    if (new Date() > new Date(match.match_datetime)) {
      return res.status(403).json({ error: 'Votación cerrada por fecha/hora' });
    }
    db.get("SELECT id FROM votes WHERE user_id = ? AND match_id = ?",
      [req.userId, matchId], (err, existing) => {
        if (existing) return res.status(403).json({ error: 'Ya votaste en este partido' });
        db.run("INSERT INTO votes (user_id, match_id, vote) VALUES (?, ?, ?)",
          [req.userId, matchId, vote], function (err) {
            if (err) return res.status(500).json({ error: 'Error al guardar voto' });
            res.json({ success: true });
          });
      });
  });
});

app.get('/api/votes', authMiddleware, (req, res) => {
  db.all("SELECT match_id, vote FROM votes WHERE user_id = ?", [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error' });
    const map = {};
    rows.forEach(r => { map[r.match_id] = r.vote; });
    res.json(map);
  });
});

app.get('/api/all-votes', authMiddleware, (req, res) => {
  db.all(`
    SELECT u.id as user_id, u.name, v.match_id, v.vote,
           m.home, m.away, m.date, m.stage
    FROM votes v
    JOIN users u ON v.user_id = u.id
    JOIN matches m ON v.match_id = m.id
    ORDER BY u.name, m.match_datetime
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error' });
    res.json(rows);
  });
});

app.get('/api/export-data', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  db.all(`
    SELECT
      u.name          AS usuario,
      m.date          AS fecha,
      m.home          AS local,
      m.away          AS visitante,
      m.stage         AS fase,
      v.vote          AS pronostico,
      r.result        AS resultado_real,
      CASE WHEN v.vote = r.result THEN 1 ELSE 0 END AS puntos
    FROM users u
    LEFT JOIN votes v ON u.id = v.user_id
    LEFT JOIN matches m ON v.match_id = m.id
    LEFT JOIN results r ON m.id = r.match_id
    WHERE u.is_admin = 0
    ORDER BY u.name, m.match_datetime
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error' });
    const campos = ['usuario', 'fecha', 'local', 'visitante', 'fase', 'pronostico', 'resultado_real', 'puntos'];
    let csv = '\uFEFF' + campos.join(',') + '\n'; // BOM para Excel
    rows.forEach(row => {
      const fila = campos.map(c => `"${(row[c] || '').toString().replace(/"/g, '""')}"`).join(',');
      csv += fila + '\n';
    });
    res.setHeader('Content-disposition', 'attachment; filename=porra_mundial2026.csv');
    res.setHeader('Content-type', 'text/csv; charset=utf-8');
    res.send(csv);
  });
});

app.get('/api/results', authMiddleware, (req, res) => {
  db.all('SELECT match_id, result FROM results', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error' });
    const map = {};
    rows.forEach(r => { map[r.match_id] = r.result; });
    res.json(map);
  });
});

app.post('/api/results', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  const { matchId, result } = req.body;
  if (!matchId) return res.status(400).json({ error: 'Falta matchId' });
  if (result !== null && !['home', 'draw', 'away'].includes(result)) {
    return res.status(400).json({ error: 'Resultado inválido' });
  }
  if (result === null) {
    db.run("DELETE FROM results WHERE match_id = ?", [matchId], (err) => {
      if (err) return res.status(500).json({ error: 'Error' });
      res.json({ success: true });
    });
  } else {
    db.run("INSERT OR REPLACE INTO results (match_id, result) VALUES (?, ?)",
      [matchId, result], function (err) {
        if (err) return res.status(500).json({ error: 'Error' });
        res.json({ success: true });
      });
  }
});

app.get('/api/leaderboard', authMiddleware, (req, res) => {
  db.all(`
    SELECT u.id, u.name,
           COALESCE(SUM(CASE WHEN v.vote = r.result THEN 1 ELSE 0 END), 0) AS points
    FROM users u
    LEFT JOIN votes v ON u.id = v.user_id
    LEFT JOIN results r ON v.match_id = r.match_id
    WHERE u.is_admin = 0
    GROUP BY u.id
    ORDER BY points DESC, u.name
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error' });
    res.json(rows);
  });
});

app.get('/api/users', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  db.all('SELECT id, name, is_admin FROM users ORDER BY name', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error' });
    res.json(rows);
  });
});

// Crear usuario admin desde panel admin
app.post('/api/admin/create-user', authMiddleware, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  const { name, password, isAdmin } = req.body;
  if (!validarNombreUsuario(name)) {
    return res.status(400).json({ error: 'Nombre inválido (2-30 caracteres)' });
  }
  if (!validarPassword(password)) {
    return res.status(400).json({ error: 'Contraseña mínimo 8 caracteres' });
  }
  const safeName = name.trim();
  db.get("SELECT id FROM users WHERE LOWER(name) = LOWER(?)", [safeName], async (err, row) => {
    if (row) return res.status(400).json({ error: 'El nombre ya existe' });
    const hash = await bcrypt.hash(password, 12);
    db.run("INSERT INTO users (name, password, is_admin) VALUES (?, ?, ?)",
      [safeName, hash, isAdmin ? 1 : 0], function (err) {
        if (err) return res.status(500).json({ error: 'Error al crear usuario' });
        res.json({ id: this.lastID, name: safeName, isAdmin: !!isAdmin });
      });
  });
});

app.delete('/api/users/:id', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo admin' });
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido' });
  db.serialize(() => {
    db.run("DELETE FROM votes WHERE user_id = ?", [userId]);
    db.run("DELETE FROM users WHERE id = ? AND is_admin = 0", [userId], function (err) {
      if (err) return res.status(500).json({ error: 'Error al eliminar' });
      if (this.changes === 0) return res.status(403).json({ error: 'No se puede eliminar a un admin' });
      res.json({ success: true });
    });
  });
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== INICIO ==========
crearAdminPorDefecto();
cargarPartidosDesdeAPI()
  .then(() => {
    actualizarResultadosAutomaticos();
    setInterval(actualizarResultadosAutomaticos, 30 * 60 * 1000);
  })
  .catch(console.error);

app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
