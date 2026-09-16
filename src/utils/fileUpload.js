/**
 * Nahrávání souborů na Cloudinary.
 *
 * **Limity jsou tady a nikde jinde.** Do 16. 9. 2026 měl `errorHandler`
 * natvrdo hlášku „max. 5 MB", jenže pět megabajtů platilo jen pro obrázky —
 * videa směla mít 200 MB. Kdo narazil na limit u videa, přečetl si, že smí
 * nahrát 5 MB, a nejspíš to vzdal. Proto se čísla **exportují** a hlášku si
 * z nich `errorHandler` skládá sám.
 */

const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/** Strop pro fotky a loga. */
const LIMIT_OBRAZEK = 25 * 1024 * 1024;

/**
 * Strop pro videa.
 *
 * **Pozor: druhý strop má Cloudinary a ten tenhle kód neovlivní.** Na
 * bezplatném tarifu propouští video do 100 MB a větší odmítne sám, takže
 * zvýšení tady se projeví, jen když na to tarif stačí. Hlášku o odmítnutí
 * z jejich strany překládá `errorHandler`.
 */
const LIMIT_VIDEO = 500 * 1024 * 1024;

function makeUploader(folder, allowedFormats = ['jpg', 'jpeg', 'png', 'webp']) {
  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: `fsl/${folder}`,
      allowed_formats: allowedFormats,
      transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
    },
  });
  return multer({ storage, limits: { fileSize: LIMIT_OBRAZEK } });
}

function makeVideoUploader(folder) {
  const storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
      folder:          `fsl/${folder}`,
      resource_type:   'video',
      allowed_formats: ['mp4', 'mov', 'avi', 'webm', 'quicktime'],
    }),
  });
  return multer({ storage, limits: { fileSize: LIMIT_VIDEO } });
}

module.exports = {
  LIMIT_OBRAZEK,
  LIMIT_VIDEO,
  uploadPhoto:          makeUploader('photos'),
  uploadLogo:           makeUploader('logos'),
  uploadAction:         makeVideoUploader('action-videos'),
  uploadHighlightVideo: makeVideoUploader('highlights'),
  uploadDraftVideo:     makeVideoUploader('draft-videos'),
  cloudinary,
};
