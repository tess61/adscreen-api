const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');

// POST /api/bookings — create booking
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role === 'owner') {
      return res.status(403).json({ message: 'Screen owners cannot make bookings.' });
    }

    const { screen_id, slot, start_date, end_date, days, subtotal, commission, total } = req.body;

    const screen = await db.query('SELECT * FROM screens WHERE id = $1', [screen_id]);
    if (screen.rows.length === 0)  return res.status(404).json({ message: 'Screen not found.' });
    if (!screen.rows[0].available) return res.status(400).json({ message: 'Screen is not available.' });

    // Check slot is still available
    const slotCheck = await db.query(
      'SELECT * FROM screen_slots WHERE screen_id = $1 AND slot = $2 AND available = TRUE',
      [screen_id, slot]
    );
    if (slotCheck.rows.length === 0) {
      return res.status(400).json({ message: 'This time slot has already been booked.' });
    }

    // Create booking
    const result = await db.query(
      'INSERT INTO bookings (screen_id, advertiser_id, slot, start_date, end_date, days, subtotal, commission, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [screen_id, req.user.id, slot, start_date, end_date, days, subtotal, commission, total]
    );

    // Mark slot as unavailable
    await db.query(
      'UPDATE screen_slots SET available = FALSE WHERE screen_id = $1 AND slot = $2',
      [screen_id, slot]
    );

    // If all slots are taken mark screen as unavailable
    const remaining = await db.query(
      'SELECT * FROM screen_slots WHERE screen_id = $1 AND available = TRUE',
      [screen_id]
    );
    if (remaining.rows.length === 0) {
      await db.query('UPDATE screens SET available = FALSE WHERE id = $1', [screen_id]);
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/bookings/my-screens — bookings on owner's screens
router.get('/my-screens', auth, async (req, res) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Not authorized.' });
    }
    const result = await db.query(
      `SELECT b.*, s.name AS screen_name, s.location,
              u.name AS advertiser_name, u.company AS advertiser_company
       FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       JOIN users u ON b.advertiser_id = u.id
       WHERE s.owner_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
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