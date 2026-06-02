const cron     = require('node-cron');
const db       = require('./db');
const { sendPushNotification } = require('./notifications');

async function completeExpiredBookings() {
  const client = await db.connect();
  try {
    console.log('⏰ Running auto-complete check...');

    await client.query('BEGIN');

    // Find all active bookings whose end date has passed
    const expired = await client.query(
      `SELECT b.*, s.owner_id, s.name AS screen_name, s.id AS screen_id,
              ou.push_token AS owner_token,
              au.push_token AS advertiser_token
       FROM bookings b
       JOIN screens s ON b.screen_id = s.id
       JOIN users ou ON s.owner_id = ou.id
       JOIN users au ON b.advertiser_id = au.id
       WHERE b.status = 'active'
         AND b.end_date < CURRENT_DATE`
    );

    if (expired.rows.length === 0) {
      await client.query('ROLLBACK');
      console.log('✅ No expired bookings found.');
      return;
    }

    console.log(`📋 Found ${expired.rows.length} expired booking(s) to complete.`);

    for (const booking of expired.rows) {
      const ownerPayout = Math.round(Number(booking.total) * 0.90);

      // Mark as completed
      await client.query(
        `UPDATE bookings SET status = 'completed' WHERE id = $1`,
        [booking.id]
      );

      // Pay owner 90%
      await client.query(
        'SELECT credit_wallet($1, $2, $3, $4, $5)',
        [
          booking.owner_id,
          ownerPayout,
          'payout',
          `Auto payout — ${booking.screen_name} campaign completed`,
          booking.id
        ]
      );

      // Restore screen availability
      await client.query(
        'UPDATE screens SET available = TRUE WHERE id = $1',
        [booking.screen_id]
      );

      console.log(`✅ Completed booking ${booking.id} — payout ${ownerPayout} ETB to owner`);

      // Notify both parties
      try {
        if (booking.owner_token) {
          await sendPushNotification(
            booking.owner_token,
            '💰 Campaign completed — payout sent',
            `Your campaign for ${booking.screen_name} has completed. ${ownerPayout.toLocaleString()} ETB has been added to your wallet.`,
            { bookingId: booking.id, type: 'campaign_completed' }
          );
        }
        if (booking.advertiser_token) {
          await sendPushNotification(
            booking.advertiser_token,
            '✅ Campaign completed',
            `Your campaign on ${booking.screen_name} has finished running.`,
            { bookingId: booking.id, type: 'campaign_completed' }
          );
        }
      } catch (e) {
        console.error('Notification error:', e.message);
      }
    }

    await client.query('COMMIT');
    console.log('✅ Auto-complete job finished.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Auto-complete job error:', err.message);
  } finally {
    client.release();
  }
}

function startCronJobs() {
  // Run every day at midnight Addis Ababa time (UTC+3 = 21:00 UTC)
  cron.schedule('0 21 * * *', () => {
    completeExpiredBookings();
  }, {
    timezone: 'Africa/Addis_Ababa'
  });

  // Also run every hour to catch any missed completions
  cron.schedule('0 * * * *', () => {
    completeExpiredBookings();
  });

  console.log('⏰ Cron jobs started — auto-complete runs every hour');
}
// Ping self every 14 minutes to prevent Render free tier spin down
cron.schedule('*/14 * * * *', async () => {
  try {
    await fetch(`https://adscreen-api.onrender.com`);
    console.log('⚡ Keep-alive ping sent');
  } catch (err) {
    console.error('Keep-alive ping failed:', err.message);
  }
});

module.exports = { startCronJobs, completeExpiredBookings };