// server.js — API Zovalux : réservations, emails, admin, album, statistiques
// Déploiement : Render (Web Service, Node)
//
// Variables d'environnement requises :
//   MONGODB_URI          -> connexion MongoDB
//   MONGODB_DB             (optionnel, défaut "zovalux")
//   GMAIL_USER            -> ex: uipact@gmail.com
//   GMAIL_APP_PASSWORD    -> mot de passe d'application Gmail (PAS ton mot de passe normal)
//   ADMIN_EMAIL           -> email qui reçoit les notifs de nouvelle réservation
//   ADMIN_SECRET          -> mot de passe pour accéder au panneau admin.html

const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(express.json({ limit: '8mb' })); // gallery images en base64
// --- Template HTML global pour les emails ---
function getEmailTemplate(title, content) {
  return `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #F6F1E7; padding: 40px 20px; color: #15120D;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05);">
        
        <!-- En-tête noire avec logo -->
        <div style="background-color: #15120D; padding: 30px; text-align: center; border-bottom: 3px solid #D4AF37;">
          <img src="https://lk10ar.github.io/Zovalux/logo.png" alt="Zovalux" style="width: 80px; height: auto;">
        </div>
        
        <!-- Contenu -->
        <div style="padding: 40px 30px;">
          <h2 style="margin-top: 0; color: #15120D; font-size: 22px; font-weight: 600;">${title}</h2>
          <div style="font-size: 15px; line-height: 1.6; color: #333333;">
            ${content}
          </div>
        </div>
        
        <!-- Pied de page -->
        <div style="background-color: #F9F9F9; padding: 20px 30px; text-align: center; font-size: 12px; color: #8A7C64; border-top: 1px solid #EEEEEE;">
          <strong>Zovalux</strong> — Nettoyage automobile premium à domicile<br>
          Bordeaux & alentours
        </div>

      </div>
    </div>
  `;
}
const ALLOWED_ORIGINS = [
  'http://zovalux.com',
  'http://www.zovalux.com',
  'https://zovalux.com',
  'https://www.zovalux.com',
  'https://lk10ar.github.io',
  'https://LK10ar.github.io', // Tolérance pour les majuscules de ton pseudo
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5501', // Port alternatif très utilisé en local
  'null' // Autorise les tests depuis un fichier ouvert sur le disque dur (file:///)
];

app.use(cors({
  origin: function(origin, callback){
    // Autorise les requêtes sans origine (comme Postman ou les scripts serveurs)
    if(!origin || origin === 'null') return callback(null, true);
    
    const originLower = origin.toLowerCase();
    
    // RÈGLE INTELLIGENTE : On autorise automatiquement tout ce qui touche à zovalux.com, GitHub ou le local
    if (
      originLower.includes('zovalux.com') || 
      originLower.includes('lk10ar.github.io') || 
      originLower.includes('localhost') || 
      originLower.includes('127.0.0.1')
    ) {
      return callback(null, true);
    }
    
    // Sinon, on bloque et on affiche l'erreur dans les logs Render
    callback(new Error('Origin non autorisée : ' + origin));
  }
}));

const MAX_PER_DAY = 3;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'zovalux';
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();
console.log(`ADMIN_SECRET chargé : ${ADMIN_SECRET ? ADMIN_SECRET.length + ' caractères' : 'ABSENT'}`);

let db;
async function getDb(){
  if(db) return db;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('bookings').createIndex({ date: 1 });
  await db.collection('visits').createIndex({ date: 1 }, { unique: true });
  return db;
}

// ---------- Email ----------
// ---------- Email (via API Brevo) ----------
async function sendMail({ to, subject, html }){
  const apiKey = process.env.BREVO_API_KEY;
  if(!apiKey){
    console.warn('BREVO_API_KEY non configurée — emails désactivés.');
    return false;
  }

  try{
    // Appel direct à l'API de Brevo en HTTPS (jamais bloqué par Render)
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        sender: { name: 'Zovalux', email: 'zovalux.pro@gmail.com' }, // Ton adresse expéditeur vérifiée
        to: [{ email: to }],
        subject: subject,
        htmlContent: html
      })
    });

    if(!response.ok){
      const errorData = await response.json();
      console.error('Erreur API Brevo:', errorData);
      return false;
    }

    return true;
  }catch(err){
    console.error('Erreur de connexion à Brevo:', err.message);
    return false;
  }
}

// ---------- Auth admin (simple) ----------
function requireAdmin(req, res, next){
  const secret = String(req.headers['x-admin-secret'] || '').trim();
  if(!ADMIN_SECRET || secret !== ADMIN_SECRET){
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}

function isValidFutureDate(dateStr){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00');
  if(isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0,0,0,0);
  return d >= today;
}

// =======================================================
// RESERVATIONS (public)
// =======================================================

// GET /api/availability?month=YYYY-MM
app.get('/api/availability', async (req, res) => {
  try{
    const month = req.query.month;
    if(!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'INVALID_MONTH' });
    const database = await getDb();
    const bookings = await database.collection('bookings')
      .find({ date: { $regex: `^${month}` }, status: { $ne: 'rejected' } })
      .project({ date: 1 })
      .toArray();
    const counts = {};
    bookings.forEach(b => { counts[b.date] = (counts[b.date] || 0) + 1; });
    res.json({ counts });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/book
app.post('/api/book', async (req, res) => {
  try{
    const { date, name, email, phone, service, vehicule, address } = req.body || {};
    if(!isValidFutureDate(date)) return res.status(400).json({ error: 'INVALID_DATE' });
    if(!name || !email || !phone) return res.status(400).json({ error: 'MISSING_FIELDS' });

    const database = await getDb();
    const collection = database.collection('bookings');
    const currentCount = await collection.countDocuments({ date, status: { $ne: 'rejected' } });
    if(currentCount >= MAX_PER_DAY) return res.status(409).json({ error: 'FULL' });

    const doc = {
      date,
      name: String(name).slice(0, 120),
      email: String(email).slice(0, 160),
      phone: String(phone).slice(0, 40),
      service: service ? String(service).slice(0, 80) : null,
      vehicule: vehicule ? String(vehicule).slice(0, 120) : null,
      address: address ? String(address).slice(0, 300) : null,
      status: 'pending', // pending | confirmed | rejected
      createdAt: new Date()
    };
    const result = await collection.insertOne(doc);

    // Email au client : demande reçue, en attente
 // Email au client : demande reçue, en attente
    sendMail({
      to: doc.email,
      subject: 'Zovalux — Votre demande de réservation est bien reçue',
      html: getEmailTemplate(
        'Demande de réservation',
        `<p>Bonjour <b>${doc.name}</b>,</p>
         <p>Votre demande pour le <b>${doc.date}</b> (${doc.service || 'formule non précisée'}) a bien été enregistrée.</p>
         <p>Elle est actuellement <b>en attente de confirmation</b> par notre équipe. Vous recevrez un nouvel email dès qu'elle sera validée.</p>
         <p>À très vite,<br>L'équipe Zovalux</p>`
      )
    });
    // Email à l'admin : nouvelle demande à traiter
    if(process.env.ADMIN_EMAIL){
      sendMail({
        to: process.env.ADMIN_EMAIL,
        subject: `Nouvelle demande de réservation — ${doc.date}`,
        html: `<p>Nouvelle demande :</p>
          <ul>
            <li>Date : ${doc.date}</li>
            <li>Nom : ${doc.name}</li>
            <li>Email : ${doc.email}</li>
            <li>Téléphone : ${doc.phone}</li>
            <li>Formule : ${doc.service || '-'}</li>
            <li>Véhicule : ${doc.vehicule || '-'}</li>
            <li>Adresse : ${doc.address || '-'}</li>
          </ul>
          <p>Rendez-vous sur le panneau admin pour confirmer ou refuser.</p>`
      });
    }

    res.json({ success: true, id: result.insertedId });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// =======================================================
// ADMIN — Réservations
// =======================================================

app.post('/api/admin/login', (req, res) => {
  const secret = String((req.body && req.body.secret) || '').trim();
  const cleanExpected = ADMIN_SECRET ? ADMIN_SECRET.trim() : ADMIN_SECRET;
  if(cleanExpected && secret === cleanExpected) return res.json({ success: true });
  res.status(401).json({ error: 'INVALID_SECRET', receivedLength: secret.length, expectedLength: cleanExpected ? cleanExpected.length : 0 });
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try{
    const database = await getDb();
    const bookings = await database.collection('bookings')
      .find({})
      .sort({ date: 1, createdAt: 1 })
      .limit(300)
      .toArray();
    res.json({ bookings });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/admin/bookings/:id/:action', requireAdmin, async (req, res) => {
  try{
    const { id, action } = req.params;
    if(!['confirm', 'reject'].includes(action)) return res.status(400).json({ error: 'INVALID_ACTION' });
    const status = action === 'confirm' ? 'confirmed' : 'rejected';

    const database = await getDb();
    const collection = database.collection('bookings');
    const booking = await collection.findOne({ _id: new ObjectId(id) });
    if(!booking) return res.status(404).json({ error: 'NOT_FOUND' });

    await collection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });

    // --- LE NOUVEAU DESIGN EST APPLIQUÉ ICI ---
    const title = status === 'confirmed' ? 'Réservation confirmée ✓' : 'Mise à jour de votre demande';
    const content = status === 'confirmed'
      ? `<p>Bonjour <b>${booking.name}</b>,</p>
         <p>Excellente nouvelle ! Votre réservation du <b>${booking.date}</b> est <b>confirmée</b>.</p>
         <p>Notre équipe se présentera à l'adresse indiquée avec tout le matériel nécessaire pour prendre soin de votre véhicule.</p>
         <p>À très bientôt,<br>L'équipe Zovalux</p>`
      : `<p>Bonjour <b>${booking.name}</b>,</p>
         <p>Nous ne pouvons malheureusement pas honorer votre demande du <b>${booking.date}</b> (créneau indisponible ou hors zone).</p>
         <p>N'hésitez pas à faire une nouvelle demande pour une autre date sur notre site.</p>
         <p>Cordialement,<br>L'équipe Zovalux</p>`;

    sendMail({
      to: booking.email,
      subject: status === 'confirmed' ? 'Zovalux — Votre réservation est confirmée ✓' : 'Zovalux — Votre demande n\'a pas pu être retenue',
      html: getEmailTemplate(title, content)
    });

    res.json({ success: true });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// =======================================================
// ALBUM AVANT / APRÈS
// =======================================================

// GET /api/gallery — public
app.get('/api/gallery', async (req, res) => {
  try{
    const database = await getDb();
    const items = await database.collection('gallery')
      .find({})
      .sort({ createdAt: -1 })
      .limit(60)
      .toArray();
    res.json({ items });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/admin/gallery — { imageData (base64), caption, type: 'before'|'after' }
app.post('/api/admin/gallery', requireAdmin, async (req, res) => {
  try{
    const { imageData, caption, type } = req.body || {};
    if(!imageData || !imageData.startsWith('data:image')) return res.status(400).json({ error: 'INVALID_IMAGE' });
    const database = await getDb();
    const result = await database.collection('gallery').insertOne({
      imageData,
      caption: caption ? String(caption).slice(0, 140) : '',
      type: (type === 'before' || type === 'after') ? type : 'after',
      createdAt: new Date()
    });
    res.json({ success: true, id: result.insertedId });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// DELETE /api/admin/gallery/:id
app.delete('/api/admin/gallery/:id', requireAdmin, async (req, res) => {
  try{
    const database = await getDb();
    await database.collection('gallery').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// =======================================================
// STATISTIQUES DE VISITE
// =======================================================

// POST /api/track-visit — appelé une fois par session sur le site public
app.post('/api/track-visit', async (req, res) => {
  try{
    const database = await getDb();
    const today = new Date().toISOString().slice(0, 10);
    await database.collection('visits').updateOne(
      { date: today },
      { $inc: { count: 1 } },
      { upsert: true }
    );
    res.json({ success: true });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try{
    const database = await getDb();
    const visits = await database.collection('visits')
      .find({})
      .sort({ date: -1 })
      .limit(60)
      .toArray();
    const total = visits.reduce((sum, v) => sum + (v.count || 0), 0);
    const bookingsTotal = await database.collection('bookings').countDocuments({});
    const bookingsPending = await database.collection('bookings').countDocuments({ status: 'pending' });
    res.json({ visits, total, bookingsTotal, bookingsPending });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/', (req, res) => res.send('Zovalux API — OK'));

// Diagnostic — ne révèle jamais la valeur, juste si les variables sont bien chargées
app.get('/api/debug-config', (req, res) => {
  res.json({
    adminSecretConfigured: !!process.env.ADMIN_SECRET,
    adminSecretLength: process.env.ADMIN_SECRET ? process.env.ADMIN_SECRET.length : 0,
    mongoConfigured: !!process.env.MONGODB_URI,
    gmailConfigured: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    adminEmailConfigured: !!process.env.ADMIN_EMAIL
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zovalux API en écoute sur le port ${PORT}`));
