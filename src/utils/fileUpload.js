const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function makeUploader(folder, allowedFormats = ['jpg', 'jpeg', 'png', 'webp']) {
  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: `fsl/${folder}`,
      allowed_formats: allowedFormats,
      transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
    },
  });
  return multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB
}

function makeVideoUploader(folder) {
  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder:        `fsl/${folder}`,
      resource_type: 'video',
      allowed_formats: ['mp4', 'mov', 'avi', 'webm'],
    },
  });
  return multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 200 MB
}

module.exports = {
  uploadPhoto:       makeUploader('photos'),
  uploadLogo:        makeUploader('logos'),
  uploadAction:      makeVideoUploader('action-videos'),
  uploadHighlightVideo: makeVideoUploader('highlights'),
};
