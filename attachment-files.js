'use strict';
const path = require('path');

// Both transports stage attachments by name. Prefix every name with its position:
// duplicate uploads (and names that sanitize identically) must never overwrite an
// earlier file. MIME types and filenames are untrusted metadata, not path pieces.
function attachmentFileName({ name, mediaType, type }, index) {
  const fallbackExt = type === 'image' ? 'png' : 'bin';
  const ext = String(mediaType || '').split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || fallbackExt;
  const base = path.basename(String(name || '').trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  let filename = base && base !== '.' && base !== '..' ? base : 'attachment';
  // Reserve room for the ordinal and MIME suffix on 255-byte filesystems. Every
  // character is ASCII after sanitizing, and keep a normal extension when trimming.
  if (filename.length > 200) {
    const suffix = path.extname(filename).slice(0, 32);
    filename = filename.slice(0, 200 - suffix.length) + suffix;
  }
  return `${index + 1}-${path.extname(filename) ? filename : `${filename}.${ext}`}`;
}

module.exports = { attachmentFileName };
