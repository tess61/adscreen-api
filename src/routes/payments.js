const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');

// GET /api/payments — get all payment methods for user
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM payment_methods WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/payments — add a payment method
router.post('/', auth, async (req, res) => {
  try {
    const { type, label, account_number, account_name, is_default } = req.body;

    if (!type || !account_number) {
      return res.status(400).json({ message: 'Type and account number are required.' });
    }

    // If setting as default remove existing default
    if (is_default) {
      await db.query(
        'UPDATE payment_methods SET is_default = FALSE WHERE user_id = $1',
        [req.user.id]
      );
    }

    // If this is the first payment method make it default automatically
    const existing = await db.query(
      'SELECT COUNT(*) FROM payment_methods WHERE user_id = $1',
      [req.user.id]
    );
    const makeDefault = is_default || parseInt(existing.rows[0].count) === 0;

    const result = await db.query(
      `INSERT INTO payment_methods
        (user_id, type, label, account_number, account_name, is_default)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, type, label, account_number, account_name, makeDefault]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/payments/:id/default — set as default
router.patch('/:id/default', auth, async (req, res) => {
  try {
    // Verify ownership
    const method = await db.query(
      'SELECT * FROM payment_methods WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (method.rows.length === 0) {
      return res.status(404).json({ message: 'Payment method not found.' });
    }

    // Remove existing default
    await db.query(
      'UPDATE payment_methods SET is_default = FALSE WHERE user_id = $1',
      [req.user.id]
    );

    // Set new default
    const result = await db.query(
      'UPDATE payment_methods SET is_default = TRUE WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/payments/:id — remove a payment method
router.delete('/:id', auth, async (req, res) => {
  try {
    const method = await db.query(
      'SELECT * FROM payment_methods WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (method.rows.length === 0) {
      return res.status(404).json({ message: 'Payment method not found.' });
    }

    await db.query('DELETE FROM payment_methods WHERE id = $1', [req.params.id]);

    // If deleted method was default set newest remaining as default
    if (method.rows[0].is_default) {
      await db.query(
        `UPDATE payment_methods SET is_default = TRUE
         WHERE user_id = $1 AND id = (
           SELECT id FROM payment_methods
           WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1
         )`,
        [req.user.id]
      );
    }

    res.json({ message: 'Payment method removed.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;