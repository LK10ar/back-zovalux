// server.js — API de réservation Zovalux (max 3 véhicules/jour)
// Déploiement : Render (Web Service, Node)
// Variable d'environnement requise : MONGODB_URI

const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

// ⚠️ Remplace par le(s) domaine(s) réel(s) de ton site une fois en ligne
const ALLOWED_ORIGINS = [
  'https://lk10ar.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];
app.use(cors({
  origin: function(origin, callback){
    if(!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Origin non autorisée'));
  }
}));

const MAX_PER_DAY = 3;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'zovalux';

if(!MONGODB_URI){
  console.error('MONGODB_URI manquant dans les variables d\'environnement.');
}

let client;
let db;

async function getDb(){
  if(db) return db;
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('bookings').createIndex({ date: 1 });
  return db;
}

// Vérifie que la date est valide (format YYYY-MM-DD) et pas dans le passé
function isValidFutureDate(dateStr){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00');
  if(isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0,0,0,0);
  return d >= today;
}

// GET /api/availability?month=YYYY-MM
// -> { counts: { "2026-08-25": 2, "2026-08-26": 3, ... } }
app.get('/api/availability', async (req, res) => {
  try{
    const month = req.query.month; // "2026-08"
    if(!month || !/^\d{4}-\d{2}$/.test(month)){
      return res.status(400).json({ error: 'INVALID_MONTH' });
    }
    const database = await getDb();
    const bookings = await database.collection('bookings')
      .find({ date: { $regex: `^${month}` } })
      .project({ date: 1 })
      .toArray();

    const counts = {};
    bookings.forEach(b => {
      counts[b.date] = (counts[b.date] || 0) + 1;
    });
    res.json({ counts });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/book
// body: { date, name, email, phone, service, vehicule, address }
app.post('/api/book', async (req, res) => {
  try{
    const { date, name, email, phone, service, vehicule, address } = req.body || {};

    if(!isValidFutureDate(date)){
      return res.status(400).json({ error: 'INVALID_DATE' });
    }
    if(!name || !email || !phone){
      return res.status(400).json({ error: 'MISSING_FIELDS' });
    }

    const database = await getDb();
    const collection = database.collection('bookings');

    // Vérification + insertion — on revérifie juste avant d'insérer
    // pour limiter les doubles réservations simultanées.
    const currentCount = await collection.countDocuments({ date });
    if(currentCount >= MAX_PER_DAY){
      return res.status(409).json({ error: 'FULL' });
    }

    await collection.insertOne({
      date,
      name: String(name).slice(0, 120),
      email: String(email).slice(0, 160),
      phone: String(phone).slice(0, 40),
      service: service ? String(service).slice(0, 80) : null,
      vehicule: vehicule ? String(vehicule).slice(0, 120) : null,
      address: address ? String(address).slice(0, 300) : null,
      createdAt: new Date()
    });

    res.json({ success: true });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/', (req, res) => {
  res.send('Zovalux booking API — OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zovalux API en écoute sur le port ${PORT}`));
