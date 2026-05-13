const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');

// GET /api/screens — all screens (public)
router.get('/', async (req, res) => {
  try {
    const { search, venue_type, min_price, max_price, available } = req.query;

    let query  = `
      SELECT s.*, u.name AS owner_name, u.company AS owner_company
      FROM screens s
      LEFT JOIN users u ON s.owner_id = u.id
      WHERE 1=1
    `;
    const params = [];
    let   idx           = 1;

    if (search) {
      query += ` AND (s.name ILIKE $${idx} OR s.location ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (venue_type) {
      query += ` AND s.venue_type = $${idx}`;
      params.push(venue_type);
      idx++;
    }
    if (min_price) {
      query += ` AND s.price >= $${idx}`;
      params.push(Number(min_price));
      idx++;
    }
    if (max_price) {
      query += ` AND s.price <= $${idx}`;
      params.push(Number(max_price));
      idx++;
    }
    if (available === 'true') {
      query += ` AND s.available = true`;
    }

    query += ` ORDER BY s.created_at DESC`;

    const result = await db.query(query, params);
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

// GET /api/screens/:id/slots — get slots a screen offers
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

// GET /api/screens/:id/availability — check which slots are free for a date range
router.get('/:id/availability', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ message: 'start_date and end_date are required.' });
    }

    const slots = await db.query(
      'SELECT slot FROM screen_slots WHERE screen_id = $1',
      [req.params.id]
    );

    const availability = await Promise.all(
      slots.rows.map(async ({ slot }) => {
        const conflict = await db.query(
          'SELECT check_booking_conflict($1, $2, $3::DATE, $4::DATE)',
          [req.params.id, slot, start_date, end_date]
        );

        const hasConflict = conflict.rows[0].check_booking_conflict;

        // If conflict find the next available date after all bookings for this slot
        let next_available = null;
        if (hasConflict) {
          const next = await db.query(
            `SELECT MAX(end_date) + INTERVAL '1 day' AS next_date
             FROM bookings
             WHERE screen_id = $1
               AND slot      = $2
               AND status    IN ('pending', 'active')
               AND end_date  >= $3::DATE`,
            [req.params.id, slot, start_date]
          );
          next_available = next.rows[0]?.next_date ?? null;
        }

        return { slot, available: !hasConflict, next_available };
      })
    );

    res.json(availability);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/screens/:id/blocked-dates?slot=Morning
router.get('/:id/blocked-dates', async (req, res) => {
  try {
    const { slot } = req.query;
    if (!slot) return res.status(400).json({ message: 'slot is required.' });

    const result = await db.query(
      `SELECT start_date, end_date
       FROM bookings
       WHERE screen_id = $1
         AND slot      = $2
         AND status    IN ('pending', 'active')
       ORDER BY start_date ASC`,
      [req.params.id, slot]
    );

    // Return array of blocked date ranges
    res.json(result.rows.map(r => ({
      start: r.start_date,
      end:   r.end_date,
    })));
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
    const screen = await db.query(
      'SELECT * FROM screens WHERE id = $1',
      [req.params.id]
    );
    if (screen.rows.length === 0) {
      return res.status(404).json({ message: 'Screen not found.' });
    }
    if (screen.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized.' });
    }

    const {
      name, location, lat, lng, price, size,
      resolution, traffic, description,
      venue_type, orientation, available
    } = req.body;

    const result = await db.query(
      `UPDATE screens SET
        name=$1, location=$2, lat=$3, lng=$4, price=$5,
        size=$6, resolution=$7, traffic=$8, description=$9,
        venue_type=$10, orientation=$11, available=$12
       WHERE id=$13 RETURNING *`,
      [
        name, location, lat, lng, price,
        size, resolution, traffic, description,
        venue_type, orientation, available,
        req.params.id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/screens/:id — delete screen (owner only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const screen = await db.query(
      'SELECT * FROM screens WHERE id = $1',
      [req.params.id]
    );
    if (screen.rows.length === 0) {
      return res.status(404).json({ message: 'Screen not found.' });
    }
    if (screen.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized.' });
    }

    // Check for active bookings
    const activeBookings = await db.query(
      `SELECT COUNT(*) FROM bookings
       WHERE screen_id = $1 AND status IN ('pending', 'active')`,
      [req.params.id]
    );
    if (parseInt(activeBookings.rows[0].count) > 0) {
      return res.status(400).json({
        message: 'Cannot delete a screen with active or pending bookings. Resolve them first.'
      });
    }

    await db.query('DELETE FROM screens WHERE id = $1', [req.params.id]);
    res.json({ message: 'Screen deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;