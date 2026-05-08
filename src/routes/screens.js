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
    const { name, location, lat, lng, price, size, resolution, traffic, description } = req.body;
    const result = await db.query(
      'INSERT INTO screens (name, location, lat, lng, price, size, resolution, traffic, description, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [name, location, lat, lng, price, size, resolution, traffic, description, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/screens/my — get screens owned by logged in user
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

module.exports = router;