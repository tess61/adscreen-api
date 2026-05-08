const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');

// POST /api/bookings — create booking
router.post('/', auth, async (req, res) => {
  try {
    const { screen_id, slot, start_date, end_date, days, subtotal, commission, total } = req.body;

    const screen = await db.query('SELECT * FROM screens WHERE id = $1', [screen_id]);
    if (screen.rows.length === 0)    return res.status(404).json({ message: 'Screen not found.' });
    if (!screen.rows[0].available)   return res.status(400).json({ message: 'Screen is not available.' });

    const result = await db.query(
      'INSERT INTO bookings (screen_id, advertiser_id, slot, start_date, end_date, days, subtotal, commission, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [screen_id, req.user.id, slot, start_date, end_date, days, subtotal, commission, total]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/bookings/my — logged-in user's bookings
router.get('/my', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT b.*, s.name AS screen_name, s.location, s.price
       FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       WHERE b.advertiser_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;