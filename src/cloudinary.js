const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isVideo = file.mimetype.startsWith('video');
    return {
      folder:          'adscreen/creatives',
      resource_type:   isVideo ? 'video' : 'image',
      allowed_formats: isVideo
        ? ['mp4', 'mov', 'avi', 'mkv']
        : ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      transformation: isVideo
        ? [{ quality: 'auto' }]
        : [{ width: 1920, height: 1080, crop: 'limit', quality: 'auto' }],
    };
  },
});

const upload = multer({ storage });

module.exports = { cloudinary, upload };