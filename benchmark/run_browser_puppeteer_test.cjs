const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DATASET_DIR = path.resolve(__dirname, '../../benchmark-dataset');
const MANIFEST_PATH = path.join(DATASET_DIR, 'manifest.json');
const RESULTS_DIR = path.resolve(__dirname, '../../benchmark-results');

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

async function runBrowserBenchmark(sampleCount = 20) {
  console.log(`🌐 Launching real Chromium browser instance via Puppeteer...`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--enable-precise-memory-info',
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log(`🧭 Navigating to live web application: http://localhost:5173/en/remove-pdf-metadata`);
  await page.goto('http://localhost:5173/en/remove-pdf-metadata', { waitUntil: 'networkidle2' });

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const validDocs = manifest.documents.filter(d => !d.isEncrypted).slice(0, sampleCount);

  console.log(`🧪 Beginning real in-browser UI testing on ${validDocs.length} actual PDF documents...`);

  const results = [];
  const csvRows = [
    'id,filename,size_kb,page_count,ui_mount_ms,wasm_worker_process_ms,total_browser_e2e_ms,browser_js_heap_mb,status'
  ];

  let tested = 0;

  for (const doc of validDocs) {
    const filePath = path.join(DATASET_DIR, 'raw', doc.name);
    if (!fs.existsSync(filePath)) continue;

    try {
      // 1. Reset / Navigate cleanly to the tool page
      await page.goto('http://localhost:5173/en/remove-pdf-metadata', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('input[type="file"]', { timeout: 10000 });

      // 2. Measure Time to Upload & Render UI Workspace
      const tUploadStart = performance.now();
      const fileInput = await page.$('input[type="file"]');
      await fileInput.uploadFile(filePath);

      // Wait for the Process button in the Editor to appear
      await page.waitForSelector('button.btn-primary', { timeout: 15000 });
      const tUiMountEnd = performance.now();
      const uiMountMs = tUiMountEnd - tUploadStart;

      // 3. Measure Execution Time when User clicks "Sanitize Metadata Now"
      const tProcessStart = performance.now();
      const processBtn = await page.$('button.btn-primary');
      await processBtn.click();

      // Wait for Download/Completion state (ProgressBar completion or reset button)
      await page.waitForFunction(
        () => document.querySelector('input[placeholder*="nama file"]') !== null ||
              document.querySelector('.progress-bar[style*="width: 100%"]') !== null ||
              document.body.innerText.includes('Wasm Client-Side') ||
              document.body.innerText.includes('Download') ||
              document.body.innerText.includes('Unduh'),
        { timeout: 30000 }
      );
      const tProcessEnd = performance.now();
      const wasmProcessMs = tProcessEnd - tProcessStart;
      const totalE2eMs = tProcessEnd - tUploadStart;

      // 4. Measure Real Chromium Memory Metrics
      const metrics = await page.metrics();
      const jsHeapMB = parseFloat((metrics.JSHeapUsedSize / (1024 * 1024)).toFixed(2));

      tested++;
      results.push({
        id: doc.id,
        filename: doc.name,
        sizeKB: doc.sizeKB,
        pageCount: doc.pageCount,
        uiMountMs: parseFloat(uiMountMs.toFixed(2)),
        wasmWorkerProcessMs: parseFloat(wasmProcessMs.toFixed(2)),
        totalBrowserE2eMs: parseFloat(totalE2eMs.toFixed(2)),
        browserJsHeapMB: jsHeapMB,
        status: 'SUCCESS'
      });

      csvRows.push([
        doc.id,
        `"${doc.name}"`,
        doc.sizeKB,
        doc.pageCount,
        uiMountMs.toFixed(2),
        wasmProcessMs.toFixed(2),
        totalE2eMs.toFixed(2),
        jsHeapMB.toFixed(2),
        'SUCCESS'
      ].join(','));

      console.log(`[Browser Test ${tested}/${validDocs.length}] ${doc.name} (${doc.sizeKB} KB) -> UI Mount: ${uiMountMs.toFixed(1)}ms | WASM Process: ${wasmProcessMs.toFixed(1)}ms | RAM: ${jsHeapMB}MB`);
    } catch (err) {
      console.warn(`⚠️ Browser test failed for ${doc.name}: ${err.message}`);
    }
  }

  await browser.close();

  // Save CSV
  const csvPath = path.join(RESULTS_DIR, 'real_browser_ui_results.csv');
  fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');

  // Calculate summary
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const summary = {
    evaluatedAt: new Date().toISOString(),
    environment: 'Real Chromium Browser Window via Puppeteer',
    webTarget: 'http://localhost:5173/en/remove-pdf-metadata',
    totalTested: results.length,
    uiMountLatencyMs: {
      mean: parseFloat(avg(results.map(r => r.uiMountMs)).toFixed(2)),
      min: Math.min(...results.map(r => r.uiMountMs)),
      max: Math.max(...results.map(r => r.uiMountMs)),
    },
    wasmProcessLatencyMs: {
      mean: parseFloat(avg(results.map(r => r.wasmWorkerProcessMs)).toFixed(2)),
      min: Math.min(...results.map(r => r.wasmWorkerProcessMs)),
      max: Math.max(...results.map(r => r.wasmWorkerProcessMs)),
    },
    totalEndToEndMs: {
      mean: parseFloat(avg(results.map(r => r.totalBrowserE2eMs)).toFixed(2)),
      min: Math.min(...results.map(r => r.totalBrowserE2eMs)),
      max: Math.max(...results.map(r => r.totalBrowserE2eMs)),
    },
    browserJsHeapMB: {
      mean: parseFloat(avg(results.map(r => r.browserJsHeapMB)).toFixed(2)),
      max: Math.max(...results.map(r => r.browserJsHeapMB)),
    }
  };

  const summaryPath = path.join(RESULTS_DIR, 'real_browser_ui_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n================== REAL BROWSER UI TEST REPORT ==================');
  console.log(`Target:               http://localhost:5173 (HandleMyFile React App)`);
  console.log(`Browser:              Real Chromium Browser`);
  console.log(`Documents Tested:     ${results.length} files from benchmark-dataset/`);
  console.log(`Mean UI Mount Time:   ${summary.uiMountLatencyMs.mean} ms`);
  console.log(`Mean WASM Processing: ${summary.wasmProcessLatencyMs.mean} ms`);
  console.log(`Mean Total E2E:       ${summary.totalEndToEndMs.mean} ms`);
  console.log(`Mean Browser RAM:     ${summary.browserJsHeapMB.mean} MB (Max: ${summary.browserJsHeapMB.max} MB)`);
  console.log(`Saved CSV:            ${csvPath}`);
  console.log(`Saved JSON:           ${summaryPath}`);
  console.log('=================================================================\n');
}

runBrowserBenchmark(20).catch(e => {
  console.error('Browser benchmark error:', e);
  process.exit(1);
});
