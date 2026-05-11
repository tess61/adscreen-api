const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');

// GET /api/screens — all screens (public)
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT s.*, u.name AS owner_name, u.company AS owner_company FROM screens s LEFT JOIN users u ON s.owner_id = u.id ORDER BY s.created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/screens/my — screens owned by logged in user
// ⚠️ Must be ABOVE /:id
router.get('/my', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM screens WHERE owner_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/screens/:id/slots — get slots for a screen
// ⚠️ Must be ABOVE /:id
router.get('/:id/slots', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM screen_slots WHERE screen_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/screens/:id/slots — set slots for a screen (owner only)
// ⚠️ Must be ABOVE /:id
router.post('/:id/slots', auth, async (req, res) => {
  try {
    const { slots } = req.body;
    const screen = await db.query('SELECT * FROM screens WHERE id = $1', [req.params.id]);
    if (screen.rows.length === 0) return res.status(404).json({ message: 'Screen not found.' });
    if (screen.rows[0].owner_id !== req.user.id) return res.status(403).json({ message: 'Not authorized.' });

    await db.query('DELETE FROM screen_slots WHERE screen_id = $1', [req.params.id]);
    for (const slot of slots) {
      await db.query(
        'INSERT INTO screen_slots (screen_id, slot) VALUES ($1, $2)',
        [req.params.id, slot]
      );
    }
    res.json({ message: 'Slots updated.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/screens/:id — one screen (public)
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT s.*, u.name AS owner_name, u.company AS owner_company FROM screens s LEFT JOIN users u ON s.owner_id = u.id WHERE s.id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Screen not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/screens — create screen (owners only)
router.post('/', auth, async (req, res) => {
  try {
    const {
      name, location, lat, lng, price,
      size, resolution, traffic, description,
      venue_type, orientation, image_url
    } = req.body;

    const result = await db.query(
      `INSERT INTO screens
        (name, location, lat, lng, price, size, resolution,
         traffic, description, venue_type, orientation, image_url, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [name, location, lat, lng, price, size, resolution,
       traffic, description, venue_type, orientation, image_url, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const { upload } = require('../cloudinary');

// POST /api/screens/upload-image — upload screen photo
router.post('/upload-image', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image provided.' });
    res.json({ image_url: req.file.path });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/screens/:id — update screen (owner only)
router.patch('/:id', auth, async (req, res) => {
  try {
    const screen = await db.query('SELECT * FROM screens WHERE id = $1', [req.params.id]);
    if (screen.rows.length === 0) return res.status(404).json({ message: 'Screen not found.' });
    if (screen.rows[0].owner_id !== req.user.id) return res.status(403).json({ message: 'Not authorized.' });

    const { name, location, lat, lng, price, size, resolution, traffic, description, available } = req.body;
    const updated = await db.query(
      'UPDATE screens SET name=$1, location=$2, lat=$3, lng=$4, price=$5, size=$6, resolution=$7, traffic=$8, description=$9, available=$10 WHERE id=$11 RETURNING *',
      [name, location, lat, lng, price, size, resolution, traffic, description, available, req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;