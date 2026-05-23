const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');
const { upload, uploadScreen } = require('../cloudinary');




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

        let next_available = null;
        if (hasConflict) {
          const next = await db.query(
            `SELECT MAX(end_date) + INTERVAL '1 day' AS next_date
             FROM bookings
             WHERE screen_id = $1
               AND status    IN ('pending', 'active')
               AND end_date  >= CURRENT_DATE
               AND (
                 slot = $2
                 OR (slot = 'Full day' AND $2 != 'Full day')
                 OR (slot != 'Full day' AND $2 = 'Full day')
               )`,
            [req.params.id, slot]
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
         AND status    IN ('pending', 'active')
         AND end_date  >= CURRENT_DATE
         AND (
           slot = $2
           OR (slot = 'Full day' AND $2 != 'Full day')
           OR (slot != 'Full day' AND $2 = 'Full day')
         )
       ORDER BY start_date ASC`,
      [req.params.id, slot]
    );

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
router.post('/', auth, uploadScreen.single('image'), async (req, res) => {
  try {
    // multer puts text fields in req.body and file in req.file
    // but sometimes with multipart the body fields come as strings
    const body = req.body;

    const name     = body.name;
    const location = body.location;

    if (!name || !location) {
      return res.status(400).json({ 
        message: 'Name and location are required.',
        received: Object.keys(body), // debug — shows what fields arrived
      });
    }

    const image_url = req.file ? req.file.path : null;

    const result = await db.query(
      `INSERT INTO screens (
        name, location, lat, lng, description,
        venue_type, orientation, size, resolution, traffic,
        image_url, owner_id, available,
        booking_model,
        total_spots_per_day, spot_duration_seconds,
        price_40spots, price_80spots, price_160spots,
        pricing_model,
        discount_7days, discount_30days,
        discount_90days, discount_180days,
        price
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,true,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,$24
      ) RETURNING *`,
      [
        body.name,
        body.location,
        body.lat        ? Number(body.lat)        : null,
        body.lng        ? Number(body.lng)        : null,
        body.description || null,
        body.venue_type  || null,
        body.orientation || null,
        body.size        || null,
        body.resolution  || null,
        body.traffic     || null,
        image_url,
        req.user.id,
        body.booking_model         || 'spots',
        body.total_spots_per_day   ? Number(body.total_spots_per_day)   : 160,
        body.spot_duration_seconds ? Number(body.spot_duration_seconds) : 15,
        body.price_40spots  ? Number(body.price_40spots)  : null,
        body.price_80spots  ? Number(body.price_80spots)  : null,
        body.price_160spots ? Number(body.price_160spots) : null,
        body.pricing_model  || 'flat',
        body.discount_7days   ? Number(body.discount_7days)   : 0,
        body.discount_30days  ? Number(body.discount_30days)  : 0,
        body.discount_90days  ? Number(body.discount_90days)  : 0,
        body.discount_180days ? Number(body.discount_180days) : 0,
        body.price_80spots  ? Number(body.price_80spots)  :
        body.price_40spots  ? Number(body.price_40spots)  : 0,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


router.post('/debug', auth, (req, res) => {
  res.json({ body: req.body, headers: req.headers['content-type'] });
});
// POST /api/screens/upload-image — upload screen photo
router.post('/', auth, upload.single('image'), async (req, res) => {
  try {
    const {
      name, location, lat, lng, description,
      venue_type, orientation, size, resolution, traffic,
      booking_model,
      total_spots_per_day, spot_duration_seconds,
      price_40spots, price_80spots, price_160spots,
      pricing_model,
      discount_7days,  discount_30days,
      discount_90days, discount_180days,
    } = req.body;

    const image_url = req.file ? req.file.path : null;

    if (!name || !location) {
      return res.status(400).json({ message: 'Name and location are required.' });
    }

    const result = await db.query(
      `INSERT INTO screens (
        name, location, lat, lng, description,
        venue_type, orientation, size, resolution, traffic,
        image_url, owner_id, available,
        booking_model,
        total_spots_per_day, spot_duration_seconds,
        price_40spots, price_80spots, price_160spots,
        pricing_model,
        discount_7days,  discount_30days,
        discount_90days, discount_180days,
        price
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,true,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,$24
      ) RETURNING *`,
      [
        name, location, lat, lng, description,
        venue_type, orientation, size, resolution, traffic,
        image_url, req.user.id,
        booking_model      || 'spots',
        total_spots_per_day || 160,
        spot_duration_seconds || 15,
        price_40spots  || null,
        price_80spots  || null,
        price_160spots || null,
        pricing_model  || 'flat',
        discount_7days   || 0, discount_30days  || 0,
        discount_90days  || 0, discount_180days || 0,
        price_80spots || 0, // use 80spots price as default price
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// PATCH /api/screens/:id — update screen (owner only)
router.patch('/:id', auth, async (req, res) => {
  try {
    const screen = await db.query(
      'SELECT * FROM screens WHERE id = $1', [req.params.id]
    );
    if (screen.rows.length === 0) {
      return res.status(404).json({ message: 'Screen not found.' });
    }
    if (screen.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized.' });
    }

    const e = screen.rows[0];
    const {
      name        = e.name,
      location    = e.location,
      lat         = e.lat,
      lng         = e.lng,
      description = e.description,
      venue_type  = e.venue_type,
      orientation = e.orientation,
      size        = e.size,
      resolution  = e.resolution,
      traffic     = e.traffic,
      available   = e.available,
      booking_model         = e.booking_model,
      total_spots_per_day   = e.total_spots_per_day,
      spot_duration_seconds = e.spot_duration_seconds,
      price_40spots         = e.price_40spots,
      price_80spots         = e.price_80spots,
      price_160spots        = e.price_160spots,
      pricing_model         = e.pricing_model,
      discount_7days        = e.discount_7days,
      discount_30days       = e.discount_30days,
      discount_90days       = e.discount_90days,
      discount_180days      = e.discount_180days,
    } = req.body;

    const result = await db.query(
      `UPDATE screens SET
        name=$1, location=$2, lat=$3, lng=$4,
        description=$5, venue_type=$6, orientation=$7,
        size=$8, resolution=$9, traffic=$10, available=$11,
        booking_model=$12,
        total_spots_per_day=$13, spot_duration_seconds=$14,
        price_40spots=$15, price_80spots=$16, price_160spots=$17,
        pricing_model=$18,
        discount_7days=$19,  discount_30days=$20,
        discount_90days=$21, discount_180days=$22,
        price=$23
       WHERE id=$24 RETURNING *`,
      [
        name, location, lat, lng,
        description, venue_type, orientation,
        size, resolution, traffic, available,
        booking_model,
        total_spots_per_day, spot_duration_seconds,
        price_40spots, price_80spots, price_160spots,
        pricing_model,
        discount_7days,  discount_30days,
        discount_90days, discount_180days,
        price_80spots || 0,
        req.params.id,
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

// PATCH /api/screens/:id/toggle-availability
router.patch('/:id/toggle-availability', auth, async (req, res) => {
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

    // Check for active bookings before marking unavailable
    if (screen.rows[0].available) {
      const activeBookings = await db.query(
        `SELECT COUNT(*) FROM bookings
         WHERE screen_id = $1
           AND status IN ('pending', 'active')`,
        [req.params.id]
      );
      if (parseInt(activeBookings.rows[0].count) > 0) {
        return res.status(400).json({
          message: 'Cannot mark as unavailable — this screen has pending or active bookings. Resolve them first.'
        });
      }
    }

    const result = await db.query(
      `UPDATE screens
       SET available = NOT available
       WHERE id = $1
       RETURNING id, name, available`,
      [req.params.id]
    );

    const updated = result.rows[0];
    res.json({
      message:   updated.available ? 'Screen is now available.' : 'Screen marked as unavailable.',
      available: updated.available,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/screens/:id/spots-availability
router.get('/:id/spots-availability', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ message: 'start_date and end_date are required.' });
    }

    // Get screen capacity
    const screen = await db.query(
      'SELECT total_spots_per_day FROM screens WHERE id = $1',
      [req.params.id]
    );
    if (screen.rows.length === 0) {
      return res.status(404).json({ message: 'Screen not found.' });
    }

    const total = screen.rows[0].total_spots_per_day;

    // Get booked spots for the date range
    const booked = await db.query(
      `SELECT COALESCE(SUM(spots_per_day), 0) AS booked_spots
       FROM bookings
       WHERE screen_id = $1
         AND status    IN ('pending', 'active')
         AND end_date  >= CURRENT_DATE
         AND (start_date, end_date) OVERLAPS ($2::DATE, $3::DATE)`,
      [req.params.id, start_date, end_date]
    );

    const bookedSpots    = parseInt(booked.rows[0].booked_spots);
    const remainingSpots = total - bookedSpots;

    res.json({
      total_spots:     total,
      booked_spots:    bookedSpots,
      remaining_spots: remainingSpots,
      available_40:    remainingSpots >= 40,
      available_80:    remainingSpots >= 80,
      available_160:   remainingSpots >= 160,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;