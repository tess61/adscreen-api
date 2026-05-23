const express = require('express');
const cors    = require('cors');
require('dotenv').config();
const { startCronJobs } = require('./cron');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());



app.use('/api/screens',  require('./routes/screens'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/wallet',   require('./routes/wallet'));
app.use('/api/payments', require('./routes/payments'))

app.get('/', (req, res) => {
  res.json({ message: 'AdScreen API is running 🚀' });
});

app.listen(process.env.PORT || 10000, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${process.env.PORT || 10000}`);
  startCronJobs();
});