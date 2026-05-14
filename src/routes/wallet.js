const express = require('express');
const router  = express.Router();
const db      = require('../db');
const auth    = require('../middleware/auth');

// GET /api/wallet — get wallet balance and transactions
router.get('/', auth, async (req, res) => {
  try {
    // Get or create wallet
    let wallet = await db.query(
      'SELECT * FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    if (wallet.rows.length === 0) {
      wallet = await db.query(
        'INSERT INTO wallets (user_id) VALUES ($1) RETURNING *',
        [req.user.id]
      );
    }

    // Get recent transactions
    const transactions = await db.query(
      `SELECT * FROM wallet_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );

    res.json({
      wallet:       wallet.rows[0],
      transactions: transactions.rows,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/wallet/topup — add credit (called after payment confirmed)
router.post('/topup', auth, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ message: 'Minimum top-up is 100 ETB.' });
    }

    // In production this is called by Telebirr/Chapa webhook
    // For now we trust the client (will be secured when real payment integrated)
    const result = await db.query(
      'SELECT credit_wallet($1, $2, $3, $4)',
      [req.user.id, amount, 'topup', `Wallet top-up of ${amount} ETB`]
    );

    const wallet = await db.query(
      'SELECT * FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      message: 'Wallet topped up successfully.',
      balance: wallet.rows[0].balance,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/wallet/balance — quick balance check
router.get('/balance', auth, async (req, res) => {
  try {
    const wallet = await db.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    if (wallet.rows.length === 0) {
      return res.json({ balance: 0 });
    }

    res.json({ balance: wallet.rows[0].balance });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;