const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');
const { sendPushNotification } = require('../notifications');
const { upload } = require('../cloudinary');


// POST /api/bookings — create booking (advertisers only)
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role === 'owner') {
      return res.status(403).json({ message: 'Screen owners cannot make bookings.' });
    }

    const { screen_id, slot, start_date, end_date, days, subtotal, commission, total } = req.body;

    // Check screen exists
    const screen = await db.query('SELECT * FROM screens WHERE id = $1', [screen_id]);
    if (screen.rows.length === 0) return res.status(404).json({ message: 'Screen not found.' });

    // Check slot exists for this screen
    const slotExists = await db.query(
      'SELECT * FROM screen_slots WHERE screen_id = $1 AND slot = $2',
      [screen_id, slot]
    );
    if (slotExists.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid slot for this screen.' });
    }

    // Check for date conflict — this is the core double booking prevention
    const conflict = await db.query(
      'SELECT check_booking_conflict($1, $2, $3::DATE, $4::DATE)',
      [screen_id, slot, start_date, end_date]
    );
    if (conflict.rows[0].check_booking_conflict) {
      return res.status(409).json({
        message: 'This slot is already booked for the selected dates. Please choose different dates or a different slot.'
      });
    }

    // No conflict — create the booking
    const result = await db.query(
      `INSERT INTO bookings
        (screen_id, advertiser_id, slot, start_date, end_date, days, subtotal, commission, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
      [screen_id, req.user.id, slot, start_date, end_date, days, subtotal, commission, total]
    );

    // Notify screen owner about new booking
    const ownerData = await db.query(
      `SELECT u.push_token, s.name AS screen_name
      FROM screens s
      JOIN users u ON s.owner_id = u.id
      WHERE s.id = $1`,
      [screen_id]
    );
    if (ownerData.rows.length > 0) {
      await sendPushNotification(
        ownerData.rows[0].push_token,
        '📋 New booking request',
        `Someone wants to book ${ownerData.rows[0].screen_name}. Review and approve it in your bookings tab.`,
        { bookingId: result.rows[0].id, type: 'new_booking' }
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/bookings/my-screens — bookings on owner's screens
// ⚠️ Must be ABOVE /my
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

// GET /api/bookings/my — advertiser's own bookings
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

// PATCH /api/bookings/:id/approve — owner approves booking
router.patch('/:id/approve', auth, async (req, res) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Not authorized.' });
    }

    const booking = await db.query(
      `SELECT b.*, s.owner_id, s.name AS screen_name,
              u.push_token AS advertiser_token
       FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       JOIN users   u ON b.advertiser_id = u.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (booking.rows.length === 0) return res.status(404).json({ message: 'Booking not found.' });
    if (booking.rows[0].owner_id !== req.user.id) return res.status(403).json({ message: 'Not authorized.' });
    if (booking.rows[0].status !== 'pending') return res.status(400).json({ message: 'Booking is not pending.' });

    const result = await db.query(
      'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *',
      ['active', req.params.id]
    );

    // Notify advertiser
    await sendPushNotification(
      booking.rows[0].advertiser_token,
      '✅ Booking approved!',
      `Your booking for ${booking.rows[0].screen_name} has been approved. Your campaign is now active.`,
      { bookingId: req.params.id, type: 'booking_approved' }
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/bookings/:id/reject — owner rejects booking
router.patch('/:id/reject', auth, async (req, res) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Not authorized.' });
    }

    const booking = await db.query(
      `SELECT b.*, s.owner_id, s.name AS screen_name,
              u.push_token AS advertiser_token
       FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       JOIN users   u ON b.advertiser_id = u.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (booking.rows.length === 0) return res.status(404).json({ message: 'Booking not found.' });
    if (booking.rows[0].owner_id !== req.user.id) return res.status(403).json({ message: 'Not authorized.' });
    if (booking.rows[0].status !== 'pending') return res.status(400).json({ message: 'Only pending bookings can be rejected.' });

    await db.query(
      'UPDATE bookings SET status = $1 WHERE id = $2',
      ['cancelled', req.params.id]
    );

    await db.query(
      'UPDATE screens SET available = TRUE WHERE id = $1',
      [booking.rows[0].screen_id]
    );

    // Notify advertiser
    await sendPushNotification(
      booking.rows[0].advertiser_token,
      '❌ Booking rejected',
      `Your booking for ${booking.rows[0].screen_name} was not approved. The dates are now available for rebooking.`,
      { bookingId: req.params.id, type: 'booking_rejected' }
    );

    res.json({ message: 'Booking rejected.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/bookings/:id/complete — mark as completed
router.patch('/:id/complete', auth, async (req, res) => {
  try {
    const booking = await db.query(
      `SELECT b.*, s.owner_id FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (booking.rows.length === 0) return res.status(404).json({ message: 'Booking not found.' });
    if (booking.rows[0].owner_id !== req.user.id) return res.status(403).json({ message: 'Not authorized.' });

    await db.query(
      'UPDATE bookings SET status = $1 WHERE id = $2',
      ['completed', req.params.id]
    );

    await db.query(
      'UPDATE screens SET available = TRUE WHERE id = $1',
      [booking.rows[0].screen_id]
    );

    res.json({ message: 'Booking marked as completed.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/bookings/:id/creative — upload ad creative
router.post('/:id/creative', auth, upload.single('creative'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file provided.' });

    // Verify this booking belongs to the advertiser
    const booking = await db.query(
      'SELECT * FROM bookings WHERE id = $1 AND advertiser_id = $2',
      [req.params.id, req.user.id]
    );
    if (booking.rows.length === 0) {
      return res.status(404).json({ message: 'Booking not found.' });
    }

    const creative_type = req.file.mimetype.startsWith('video') ? 'video' : 'image';

    await db.query(
      'UPDATE bookings SET creative_url = $1, creative_type = $2 WHERE id = $3',
      [req.file.path, creative_type, req.params.id]
    );

    res.json({ creative_url: req.file.path, creative_type });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;