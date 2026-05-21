// @ts-nocheck
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');
const { sendPushNotification } = require('../notifications');

// Helper: calculate cancellation fee
function getCancellationFee(booking) {
  const now       = new Date();
  const startDate = new Date(booking.start_date);
  const hoursToStart = (startDate - now) / (1000 * 60 * 60);
  const total     = Number(booking.total);

  if (booking.status === 'pending') {
    return {
      fee:            Math.round(total * 0.05),
      refund:         Math.round(total * 0.95),
      ownerShare:     0,
      adscreenShare:  Math.round(total * 0.05),
      stage:          1,
      label:          '5% cancellation fee (booking was pending)',
    };
  }

  if (booking.status === 'active' && hoursToStart > 48) {
    return {
      fee:            Math.round(total * 0.20),
      refund:         Math.round(total * 0.80),
      ownerShare:     Math.round(total * 0.15),
      adscreenShare:  Math.round(total * 0.05),
      stage:          2,
      label:          '20% cancellation fee (cancelled more than 48hrs before start)',
    };
  }

  if (booking.status === 'active' && hoursToStart <= 48 && hoursToStart > 0) {
    return {
      fee:            Math.round(total * 0.50),
      refund:         Math.round(total * 0.50),
      ownerShare:     Math.round(total * 0.40),
      adscreenShare:  Math.round(total * 0.10),
      stage:          3,
      label:          '50% cancellation fee (cancelled less than 48hrs before start)',
    };
  }

  // Campaign already started
  return null;
}

// POST /api/bookings — create booking with wallet deduction
router.post('/', auth, async (req, res) => {
  const client = await db.connect();
  try {
    if (req.user.role === 'owner') {
      return res.status(403).json({ message: 'Screen owners cannot make bookings.' });
    }

    const {
      screen_id,
      // Spots model fields
      spots_per_day, spot_duration_seconds, package_label,
      // Timeslot model fields
      slot,
      // Common fields
      start_date, end_date, days,
      subtotal, commission, total,
    } = req.body;

    await client.query('BEGIN');

    // Check wallet balance
    const wallet = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );
    const balance = wallet.rows.length > 0 ? Number(wallet.rows[0].balance) : 0;
    if (balance < total) {
      await client.query('ROLLBACK');
      return res.status(402).json({
        message:   'Insufficient wallet balance.',
        required:  total,
        balance:   balance,
        shortfall: total - balance,
      });
    }

    // Check screen exists
    const screen = await client.query(
      'SELECT * FROM screens WHERE id = $1 FOR UPDATE',
      [screen_id]
    );
    if (screen.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Screen not found.' });
    }

    const isSpots = screen.rows[0].booking_model === 'spots' || spots_per_day;

    if (isSpots) {
      // Spots conflict check
      const conflict = await client.query(
        'SELECT check_spots_conflict($1, $2::DATE, $3::DATE, $4)',
        [screen_id, start_date, end_date, spots_per_day]
      );
      if (conflict.rows[0].check_spots_conflict) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'Not enough spots available for the selected dates. Choose fewer spots or different dates.',
        });
      }
    } else {
      // Timeslot — check slot passed for today
      const today = new Date().toISOString().split('T')[0];
      if (start_date === today && slot) {
        const now  = new Date();
        const hour = now.getHours();
        const slotEndHours = {
          'Morning (6am–12pm)':   12,
          'Afternoon (12pm–6pm)': 18,
          'Evening (6pm–12am)':   24,
          'Full day':             24,
        };
        const endHour = slotEndHours[slot];
        if (endHour !== undefined && hour >= endHour) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            message: `The ${slot} slot has already passed for today.`
          });
        }
      }

      // Timeslot conflict check
      const slotExists = await client.query(
        'SELECT * FROM screen_slots WHERE screen_id = $1 AND slot = $2',
        [screen_id, slot]
      );
      if (slotExists.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Invalid slot for this screen.' });
      }

      const conflict = await client.query(
        'SELECT check_booking_conflict($1, $2, $3::DATE, $4::DATE)',
        [screen_id, slot, start_date, end_date]
      );
      if (conflict.rows[0].check_booking_conflict) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'This slot is already booked for the selected dates.',
        });
      }
    }

    // Create booking — handles both models
    const result = await client.query(
  `INSERT INTO bookings (
    screen_id, advertiser_id,
    slot, spots_per_day, spot_duration_seconds, package_label,
    start_date, end_date, days,
    subtotal, commission, total,
    status, paid_at,
    platform_commission, owner_payout
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
    'pending',NOW(),$13,$14
  ) RETURNING *`,
  [
    screen_id, req.user.id,
    slot              || null,
    spots_per_day     || null,
    spot_duration_seconds || null,
    package_label     || null,
    start_date, end_date, days,
    subtotal, commission, total,
    Math.round(total * 0.10),
    Math.round(total * 0.90),
  ]
);

    const booking = result.rows[0];

    // Deduct from wallet
    const description = isSpots
      ? `Campaign for ${screen.rows[0].name} - ${package_label} (${spots_per_day} spots/day)`
      : `Campaign for ${screen.rows[0].name} - ${slot}`;

    await client.query(
      'SELECT deduct_wallet($1, $2, $3, $4, $5)',
      [req.user.id, total, 'booking_payment', description, booking.id]
    );

    await client.query('COMMIT');

    // Notify owner
    try {
      const ownerData = await db.query(
        `SELECT u.push_token, s.name AS screen_name
         FROM screens s JOIN users u ON s.owner_id = u.id
         WHERE s.id = $1`,
        [screen_id]
      );
      if (ownerData.rows[0]?.push_token) {
        await sendPushNotification(
          ownerData.rows[0].push_token,
          '📋 New campaign request',
          `Someone wants to run a campaign on ${ownerData.rows[0].screen_name}.`,
          { bookingId: booking.id, type: 'new_booking' }
        );
      }
    } catch (e) { console.error(e); }

    res.status(201).json(booking);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

// GET /api/bookings/my-screens — owner's bookings
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
       JOIN users   u ON b.advertiser_id = u.id
       WHERE s.owner_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/bookings/my — advertiser's bookings
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

// GET /api/bookings/:id/cancellation-preview
// Shows fee before advertiser confirms cancel
router.get('/:id/cancellation-preview', auth, async (req, res) => {
  try {
    const booking = await db.query(
      'SELECT * FROM bookings WHERE id = $1 AND advertiser_id = $2',
      [req.params.id, req.user.id]
    );
    if (booking.rows.length === 0) {
      return res.status(404).json({ message: 'Booking not found.' });
    }

    const b    = booking.rows[0];
    const info = getCancellationFee(b);

    if (!info) {
      return res.status(400).json({
        message: 'This campaign has already started and cannot be cancelled.',
      });
    }

    res.json({
      total:    Number(b.total),
      ...info,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/bookings/:id/cancel — advertiser cancels
router.post('/:id/cancel', auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const booking = await client.query(
      `SELECT b.*, s.owner_id, s.name AS screen_name,
              u.push_token AS owner_token
       FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       JOIN users   u ON s.owner_id  = u.id
       WHERE b.id = $1 AND b.advertiser_id = $2
       FOR UPDATE`,
      [req.params.id, req.user.id]
    );

    if (booking.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Booking not found.' });
    }

    const b    = booking.rows[0];
    const info = getCancellationFee(b);

    if (!info) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'This campaign has already started and cannot be cancelled.',
      });
    }

    // Update booking status
    await client.query(
      `UPDATE bookings SET
         status           = 'cancelled',
         cancelled_by     = 'advertiser',
         cancelled_at     = NOW(),
         cancellation_fee = $1
       WHERE id = $2`,
      [info.fee, b.id]
    );

    // Refund advertiser (minus fee)
    if (info.refund > 0) {
      await client.query(
        'SELECT credit_wallet($1, $2, $3, $4, $5)',
        [req.user.id, info.refund, 'refund',
         `Refund for cancelled booking — ${b.screen_name} (${info.label})`,
         b.id]
      );
    }

    // Pay owner their share of cancellation fee if any
    if (info.ownerShare > 0) {
      await client.query(
        'SELECT credit_wallet($1, $2, $3, $4, $5)',
        [b.owner_id, info.ownerShare, 'payout',
         `Cancellation compensation — ${b.screen_name}`,
         b.id]
      );
    }

    // Restore screen availability
    await client.query(
      'UPDATE screens SET available = TRUE WHERE id = $1',
      [b.screen_id]
    );

    await client.query('COMMIT');

    // Notify owner
    try {
      if (b.owner_token) {
        await sendPushNotification(
          b.owner_token,
          '❌ Booking cancelled',
          `An advertiser cancelled their booking for ${b.screen_name}.`,
          { bookingId: b.id, type: 'booking_cancelled' }
        );
      }
    } catch (e) { console.error(e); }

    res.json({
      message: 'Booking cancelled.',
      refund:  info.refund,
      fee:     info.fee,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/bookings/:id/approve — owner approves
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
    if (booking.rows.length === 0) {
      return res.status(404).json({ message: 'Booking not found.' });
    }
    if (booking.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized.' });
    }
    if (booking.rows[0].status !== 'pending') {
      return res.status(400).json({ message: 'Booking is not pending.' });
    }

    // Block approval if no creative uploaded
    if (!booking.rows[0].creative_url) {
      return res.status(400).json({
        message: 'Cannot approve — advertiser has not uploaded their ad creative yet.',
      });
    }

    const result = await db.query(
      'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *',
      ['active', req.params.id]
    );

    try {
      if (booking.rows[0].advertiser_token) {
        await sendPushNotification(
          booking.rows[0].advertiser_token,
          '✅ Booking approved!',
          `Your booking for ${booking.rows[0].screen_name} has been approved.`,
          { bookingId: req.params.id, type: 'booking_approved' }
        );
      }
    } catch (e) { console.error(e); }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/bookings/:id/reject — owner rejects (full refund)
router.patch('/:id/reject', auth, async (req, res) => {
  const client = await db.connect();
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Not authorized.' });
    }

    await client.query('BEGIN');

    const booking = await client.query(
      `SELECT b.*, s.owner_id, s.name AS screen_name,
              u.push_token AS advertiser_token
       FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       JOIN users   u ON b.advertiser_id = u.id
       WHERE b.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (booking.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Booking not found.' });
    }
    if (booking.rows[0].owner_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Not authorized.' });
    }
    if (booking.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Only pending bookings can be rejected.' });
    }

    const b = booking.rows[0];

    // Cancel booking
    await client.query(
      `UPDATE bookings SET
         status       = 'cancelled',
         cancelled_by = 'owner',
         cancelled_at = NOW()
       WHERE id = $1`,
      [b.id]
    );

    // Full refund — owner rejection means no fee
    await client.query(
      'SELECT credit_wallet($1, $2, $3, $4, $5)',
      [b.advertiser_id, Number(b.total), 'refund',
       `Full refund — booking rejected by screen owner (${b.screen_name})`,
       b.id]
    );

    // Restore screen availability
    await client.query(
      'UPDATE screens SET available = TRUE WHERE id = $1',
      [b.screen_id]
    );

    await client.query('COMMIT');

    try {
      if (b.advertiser_token) {
        await sendPushNotification(
          b.advertiser_token,
          '❌ Booking rejected',
          `Your booking for ${b.screen_name} was rejected. Full refund sent to your wallet.`,
          { bookingId: b.id, type: 'booking_rejected' }
        );
      }
    } catch (e) { console.error(e); }

    res.json({ message: 'Booking rejected. Full refund issued to advertiser.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/bookings/:id/complete — mark complete and pay owner
router.patch('/:id/complete', auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const booking = await client.query(
      `SELECT b.*, s.owner_id, s.name AS screen_name
       FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       WHERE b.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (booking.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Booking not found.' });
    }
    if (booking.rows[0].owner_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Not authorized.' });
    }
    if (booking.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Only active bookings can be completed.' });
    }

    const b           = booking.rows[0];
    const ownerPayout = Math.round(Number(b.total) * 0.90);

    // Mark complete
    await client.query(
      'UPDATE bookings SET status = $1 WHERE id = $2',
      ['completed', b.id]
    );

    // Pay owner 90%
    await client.query(
      'SELECT credit_wallet($1, $2, $3, $4, $5)',
      [b.owner_id, ownerPayout, 'payout',
       `Campaign payout — ${b.screen_name} (90% of ${Number(b.total).toLocaleString()} ETB)`,
       b.id]
    );

    // Restore screen availability
    await client.query(
      'UPDATE screens SET available = TRUE WHERE id = $1',
      [b.screen_id]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Campaign completed.',
      payout:  ownerPayout,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

// POST /api/bookings/:id/creative — upload creative
router.post('/:id/creative', auth, async (req, res) => {
  const { upload } = require('../cloudinary');
  upload.single('creative')(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    try {
      if (!req.file) return res.status(400).json({ message: 'No file provided.' });

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
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
});

// POST /api/bookings/run-autocomplete — manual trigger (admin only, remove after testing)
router.post('/run-autocomplete', async (req, res) => {
  try {
    const { completeExpiredBookings } = require('../cron');
    await completeExpiredBookings();
    res.json({ message: 'Auto-complete job ran successfully.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/bookings/trigger-autocomplete — trigger auto-complete for testing (remove in production)
router.post('/trigger-autocomplete', async (req, res) => {
  try {
    const { completeExpiredBookings } = require('../cron');
    await completeExpiredBookings();
    res.json({ message: 'Auto-complete ran successfully.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;