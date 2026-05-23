const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Keep your existing storage for creative files (unchanged)
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

// NEW storage for screen images (doesn't affect existing code)
const screenImageStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'adscreen/screens',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    transformation: [
      { width: 1200, height: 800, crop: 'limit', quality: 'auto' }
    ],
  },
});

// Keep the original upload export for backward compatibility
const upload = multer({ storage });

// Export both - existing code continues to work
module.exports = { 
  cloudinary, 
  upload,                    // ← Original one, unchanged for existing code
  uploadScreenImage: multer({ storage: screenImageStorage })  // ← New one for screens
};