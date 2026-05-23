const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const auth = require('../middleware/auth');
const { upload } = require('../cloudinary');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, company, phone } = req.body;

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ message: 'Email already registered.' });

    const hashed = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (name, email, password, role, company, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, role, avatar_url',
      [name, email, hashed, role || 'advertiser', company, phone]
    );

    const user  = result.rows[0];
    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ token, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user   = result.rows[0];
    if (!user) return res.status(400).json({ message: 'Invalid credentials.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Invalid credentials.' });

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar_url: user.avatar_url } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// POST /api/auth/push-token — save device push token
router.post('/push-token', auth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Token required.' });

    await db.query(
      'UPDATE users SET push_token = $1 WHERE id = $2',
      [token, req.user.id]
    );
    res.json({ message: 'Push token saved.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/auth/me — get current user profile
router.get('/me', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, role, company, phone,
              telebirr_number, telebirr_name, avatar_url
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/auth/me — update profile
router.patch('/me', auth, async (req, res) => {
  try {
    const { name, company, phone } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ message: 'Name is required.' });
    }

    const result = await db.query(
      `UPDATE users SET name=$1, company=$2, phone=$3 WHERE id=$4
       RETURNING id, name, email, role, company, phone, avatar_url`,
      [name.trim(), company, phone, req.user.id]
    );

    // Update stored user in response so app can sync
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/auth/change-password
router.patch('/change-password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ message: 'Both current and new password are required.' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    }

    // Get current password hash
    const user = await db.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ message: 'User not found.' });

    // Verify current password
    const match = await bcrypt.compare(current_password, user.rows[0].password);
    if (!match) return res.status(400).json({ message: 'Current password is incorrect.' });

    // Hash and save new password
    const hashed = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, req.user.id]);

    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/auth/payment — save Telebirr details
router.patch('/payment', auth, async (req, res) => {
  try {
    const { telebirr_number, telebirr_name } = req.body;

    if (!telebirr_number) {
      return res.status(400).json({ message: 'Telebirr number is required.' });
    }

    // Basic Ethiopian phone number validation
    const cleaned = telebirr_number.replace(/\s/g, '');
    const validFormats = [
      /^09\d{8}$/,        // 09XXXXXXXX
      /^\+2519\d{8}$/,    // +2519XXXXXXXX
      /^2519\d{8}$/,      // 2519XXXXXXXX
    ];
    const isValid = validFormats.some(f => f.test(cleaned));
    if (!isValid) {
      return res.status(400).json({ 
        message: 'Please enter a valid Ethiopian phone number (e.g. 0912345678).' 
      });
    }

    const result = await db.query(
      `UPDATE users SET telebirr_number=$1, telebirr_name=$2 WHERE id=$3
       RETURNING id, name, email, role, company, phone, telebirr_number, telebirr_name`,
      [cleaned, telebirr_name, req.user.id]
    );

    // Update SecureStore via response
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/avatar — upload profile photo
router.post('/avatar', auth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image provided.' });

    const result = await db.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id, name, email, role, company, phone, avatar_url',
      [req.file.path, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/auth/avatar — remove profile photo
router.delete('/avatar', auth, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET avatar_url = NULL WHERE id = $1',
      [req.user.id]
    );
    res.json({ message: 'Avatar removed.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/auth/stats — get role-specific stats for profile
router.get('/stats', auth, async (req, res) => {
  try {
    if (req.user.role === 'owner') {
      const [screens, bookings, wallet] = await Promise.all([
        db.query(
          'SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE available = true) AS active FROM screens WHERE owner_id = $1',
          [req.user.id]
        ),
        db.query(
          `SELECT
            COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
            COUNT(*) FILTER (WHERE status = 'active')    AS active,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed
           FROM bookings b
           JOIN screens s ON b.screen_id = s.id
           WHERE s.owner_id = $1`,
          [req.user.id]
        ),
        db.query(
          'SELECT balance, total_earned FROM wallets WHERE user_id = $1',
          [req.user.id]
        ),
      ]);

      res.json({
        role:             'owner',
        total_screens:    parseInt(screens.rows[0].total),
        active_screens:   parseInt(screens.rows[0].active),
        pending_bookings: parseInt(bookings.rows[0].pending),
        active_campaigns: parseInt(bookings.rows[0].active),
        completed_campaigns: parseInt(bookings.rows[0].completed),
        wallet_balance:   Number(wallet.rows[0]?.balance      ?? 0),
        total_earned:     Number(wallet.rows[0]?.total_earned  ?? 0),
      });
    } else {
      const [bookings, wallet] = await Promise.all([
        db.query(
          `SELECT
            COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
            COUNT(*) FILTER (WHERE status = 'active')    AS active,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed,
            COALESCE(SUM(total), 0)                      AS total_spent
           FROM bookings
           WHERE advertiser_id = $1`,
          [req.user.id]
        ),
        db.query(
          'SELECT balance, total_spent FROM wallets WHERE user_id = $1',
          [req.user.id]
        ),
      ]);

      res.json({
        role:             'advertiser',
        pending_campaigns:   parseInt(bookings.rows[0].pending),
        active_campaigns:    parseInt(bookings.rows[0].active),
        completed_campaigns: parseInt(bookings.rows[0].completed),
        total_campaigns:     parseInt(bookings.rows[0].pending) +
                             parseInt(bookings.rows[0].active) +
                             parseInt(bookings.rows[0].completed),
        total_spent:      Number(bookings.rows[0].total_spent ?? 0),
        wallet_balance:   Number(wallet.rows[0]?.balance      ?? 0),
      });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;