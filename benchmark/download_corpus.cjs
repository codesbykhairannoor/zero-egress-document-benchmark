const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');

const BASE_DIR = path.resolve(__dirname, '../../benchmark-dataset');
const RAW_DIR = path.join(BASE_DIR, 'raw');
const LIGHT_DIR = path.join(BASE_DIR, '1-light');
const MEDIUM_DIR = path.join(BASE_DIR, '2-medium');
const HEAVY_DIR = path.join(BASE_DIR, '3-heavy');
const COMPLEX_DIR = path.join(BASE_DIR, '4-complex');

[BASE_DIR, RAW_DIR, LIGHT_DIR, MEDIUM_DIR, HEAVY_DIR, COMPLEX_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Fetch list of PDFs from Mozilla pdf.js test repository
async function fetchFileList() {
  console.log('📡 Fetching list of research-grade test PDFs from Mozilla pdf.js repository...');
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: '/repos/mozilla/pdf.js/contents/test/pdfs',
      headers: { 'User-Agent': 'HandleMyFile-DeepResearch/1.0' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const files = JSON.parse(data);
          if (!Array.isArray(files)) {
            return reject(new Error('GitHub API response is not an array: ' + data));
          }
          const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
          console.log(`✅ Found ${pdfs.length} curated PDF test documents!`);
          resolve(pdfs);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

// Download a single file with retry
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      return resolve({ cached: true, size: fs.statSync(destPath).size });
    }

    const file = fs.createWriteStream(destPath);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        return reject(new Error(`Failed with status ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve({ cached: false, size: fs.statSync(destPath).size }));
      });
    }).on('error', err => {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

// Download pool with concurrency control
async function downloadCorpus(pdfs, limit = 500) {
  const selected = pdfs.slice(0, limit);
  console.log(`🚀 Starting parallel download of ${selected.length} PDFs (Concurrency: 5)...`);
  
  let completed = 0;
  let failed = 0;
  const manifest = [];

  const pool = [...selected];
  const workers = Array.from({ length: 5 }, async () => {
    while (pool.length > 0) {
      const item = pool.shift();
      const rawFile = path.join(RAW_DIR, item.name);
      const rawUrl = `https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/${encodeURIComponent(item.name)}`;
      
      try {
        const { size } = await downloadFile(rawUrl, rawFile);
        completed++;
        
        // Calculate SHA256 checksum
        const fileBuffer = fs.readFileSync(rawFile);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        
        // Inspect page count via pdf-lib if valid
        let pageCount = 0;
        let isEncrypted = false;
        try {
          const doc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
          pageCount = doc.getPageCount();
        } catch (e) {
          if (e.message && e.message.toLowerCase().includes('encrypt')) {
            isEncrypted = true;
          }
        }

        // Categorize into stratification tiers
        let tier = '1-light';
        let targetDir = LIGHT_DIR;
        const sizeKB = size / 1024;

        if (isEncrypted) {
          tier = '4-complex';
          targetDir = COMPLEX_DIR;
        } else if (sizeKB > 5000 || pageCount > 50) {
          tier = '3-heavy';
          targetDir = HEAVY_DIR;
        } else if (sizeKB > 500 || pageCount > 10) {
          tier = '2-medium';
          targetDir = MEDIUM_DIR;
        }

        const categorizedFile = path.join(targetDir, item.name);
        if (!fs.existsSync(categorizedFile)) {
          fs.copyFileSync(rawFile, categorizedFile);
        }

        manifest.push({
          id: completed,
          name: item.name,
          sizeBytes: size,
          sizeKB: parseFloat(sizeKB.toFixed(2)),
          pageCount,
          tier,
          isEncrypted,
          sha256: hash,
        });

        if (completed % 25 === 0 || completed === selected.length) {
          console.log(`[Progress] Downloaded & profiled: ${completed}/${selected.length} (${(completed/selected.length*100).toFixed(1)}%)`);
        }
      } catch (err) {
        failed++;
        console.warn(`⚠️ Skipped ${item.name}: ${err.message}`);
      }
    }
  });

  await Promise.all(workers);

  // Generate synthetic PDFs to round out coverage if needed
  console.log(`\n📊 Download complete: ${completed} succeeded, ${failed} failed.`);
  
  // Save research manifest
  const manifestPath = path.join(BASE_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalDocuments: manifest.length,
    tiers: {
      light: manifest.filter(m => m.tier === '1-light').length,
      medium: manifest.filter(m => m.tier === '2-medium').length,
      heavy: manifest.filter(m => m.tier === '3-heavy').length,
      complex: manifest.filter(m => m.tier === '4-complex').length,
    },
    documents: manifest
  }, null, 2));

  console.log(`💾 Saved scientific dataset manifest: ${manifestPath}`);
  console.log(`📈 Summary of Stratification:`);
  console.log(`   - 1-Light (< 500KB):   ${manifest.filter(m => m.tier === '1-light').length} docs`);
  console.log(`   - 2-Medium (0.5-5MB):  ${manifest.filter(m => m.tier === '2-medium').length} docs`);
  console.log(`   - 3-Heavy (> 5MB):     ${manifest.filter(m => m.tier === '3-heavy').length} docs`);
  console.log(`   - 4-Complex/Encrypted: ${manifest.filter(m => m.tier === '4-complex').length} docs`);
}

async function main() {
  try {
    const pdfs = await fetchFileList();
    // Target 500 PDFs as requested
    const targetCount = Math.min(500, pdfs.length);
    await downloadCorpus(pdfs, targetCount);
  } catch (err) {
    console.error('Fatal error downloading corpus:', err);
    process.exit(1);
  }
}

main();
