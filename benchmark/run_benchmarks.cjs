const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const DATASET_DIR = path.resolve(__dirname, '../../benchmark-dataset');
const MANIFEST_PATH = path.join(DATASET_DIR, 'manifest.json');
const RESULTS_DIR = path.resolve(__dirname, '../../benchmark-results');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function calculateStats(numbers) {
  if (numbers.length === 0) return { mean: 0, stdDev: 0, median: 0, min: 0, max: 0 };
  const sorted = [...numbers].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / sorted.length;
  const stdDev = Math.sqrt(variance);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    mean: parseFloat(mean.toFixed(2)),
    stdDev: parseFloat(stdDev.toFixed(2)),
    median: parseFloat(median.toFixed(2)),
    min: parseFloat(sorted[0].toFixed(2)),
    max: parseFloat(sorted[sorted.length - 1].toFixed(2)),
  };
}

async function runBenchmark() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('❌ Manifest not found. Please run download_corpus.cjs first.');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const docs = manifest.documents.filter(d => !d.isEncrypted);
  console.log(`🔬 Initiating empirical benchmark on ${docs.length} unencrypted PDF documents...`);

  const results = [];
  const csvRows = [
    'id,filename,tier,sizeKB,pageCount,parseMs,sanitizeMs,splitMs,saveMs,totalMs,memDeltaMB,throughputMBps'
  ];

  let processed = 0;
  for (const docInfo of docs) {
    const filePath = path.join(DATASET_DIR, 'raw', docInfo.name);
    if (!fs.existsSync(filePath)) continue;

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const sizeMB = fileBuffer.length / (1024 * 1024);

      if (global.gc) global.gc();
      const memBefore = process.memoryUsage().heapUsed;

      // 1. Measure Parse Latency
      const t0 = performance.now();
      const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
      const tParse = performance.now() - t0;

      // 2. Measure Metadata Sanitization (Privacy Layer)
      const t1 = performance.now();
      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer('HandleMyFile In-Browser Research Engine');
      pdfDoc.setCreator('Zero-Knowledge Client-Side Pipeline');
      const tSanitize = performance.now() - t1;

      // 3. Measure Page Extraction / Split Latency
      const t2 = performance.now();
      const pageCount = pdfDoc.getPageCount();
      if (pageCount > 1) {
        const subDoc = await PDFDocument.create();
        const copied = await subDoc.copyPages(pdfDoc, [0]);
        subDoc.addPage(copied[0]);
      }
      const tSplit = performance.now() - t2;

      // 4. Measure Binary Serialization (Save/Write)
      const t3 = performance.now();
      const savedBytes = await pdfDoc.save();
      const tSave = performance.now() - t3;

      const memAfter = process.memoryUsage().heapUsed;
      const memDeltaMB = Math.max(0, (memAfter - memBefore) / (1024 * 1024));

      const totalMs = tParse + tSanitize + tSplit + tSave;
      const throughputMBps = totalMs > 0 ? (sizeMB / (totalMs / 1000)) : 0;

      results.push({
        id: docInfo.id,
        filename: docInfo.name,
        tier: docInfo.tier,
        sizeKB: docInfo.sizeKB,
        pageCount,
        parseMs: parseFloat(tParse.toFixed(2)),
        sanitizeMs: parseFloat(tSanitize.toFixed(2)),
        splitMs: parseFloat(tSplit.toFixed(2)),
        saveMs: parseFloat(tSave.toFixed(2)),
        totalMs: parseFloat(totalMs.toFixed(2)),
        memDeltaMB: parseFloat(memDeltaMB.toFixed(2)),
        throughputMBps: parseFloat(throughputMBps.toFixed(2)),
      });

      csvRows.push([
        docInfo.id,
        `"${docInfo.name}"`,
        docInfo.tier,
        docInfo.sizeKB,
        pageCount,
        tParse.toFixed(2),
        tSanitize.toFixed(2),
        tSplit.toFixed(2),
        tSave.toFixed(2),
        totalMs.toFixed(2),
        memDeltaMB.toFixed(2),
        throughputMBps.toFixed(2)
      ].join(','));

      processed++;
      if (processed % 25 === 0 || processed === docs.length) {
        console.log(`[Benchmark Progress] Processed ${processed}/${docs.length} (${(processed/docs.length*100).toFixed(1)}%)`);
      }
    } catch (e) {
      console.warn(`⚠️ Error benchmarking ${docInfo.name}: ${e.message}`);
    }
  }

  // Write CSV
  const csvPath = path.join(RESULTS_DIR, 'benchmark_raw.csv');
  fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
  console.log(`\n💾 Raw empirical dataset saved to: ${csvPath}`);

  // Compute Stratified Statistical Metrics
  const tiers = ['1-light', '2-medium', '3-heavy'];
  const summaryByTier = {};

  for (const tier of tiers) {
    const tierDocs = results.filter(r => r.tier === tier);
    summaryByTier[tier] = {
      sampleCount: tierDocs.length,
      latencyTotalMs: calculateStats(tierDocs.map(d => d.totalMs)),
      parseLatencyMs: calculateStats(tierDocs.map(d => d.parseMs)),
      saveLatencyMs: calculateStats(tierDocs.map(d => d.saveMs)),
      memoryDeltaMB: calculateStats(tierDocs.map(d => d.memDeltaMB)),
      throughputMBps: calculateStats(tierDocs.map(d => d.throughputMBps)),
    };
  }

  const fullSummary = {
    evaluatedAt: new Date().toISOString(),
    totalEvaluated: results.length,
    overall: {
      latencyTotalMs: calculateStats(results.map(d => d.totalMs)),
      memoryDeltaMB: calculateStats(results.map(d => d.memDeltaMB)),
      throughputMBps: calculateStats(results.map(d => d.throughputMBps)),
    },
    stratification: summaryByTier,
  };

  const summaryPath = path.join(RESULTS_DIR, 'benchmark_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(fullSummary, null, 2), 'utf8');
  console.log(`📊 Research Summary JSON saved to: ${summaryPath}`);

  console.log('\n================== EMPIRICAL BENCHMARK RESULTS ==================');
  console.log(`Total Documents Processed: ${results.length}`);
  console.log(`Mean Processing Latency:   ${fullSummary.overall.latencyTotalMs.mean} ms (StdDev: ${fullSummary.overall.latencyTotalMs.stdDev} ms)`);
  console.log(`Median Processing Latency: ${fullSummary.overall.latencyTotalMs.median} ms`);
  console.log(`Mean Memory Delta:         ${fullSummary.overall.memoryDeltaMB.mean} MB (Max: ${fullSummary.overall.memoryDeltaMB.max} MB)`);
  console.log(`Mean Throughput:           ${fullSummary.overall.throughputMBps.mean} MB/s`);
  console.log('=================================================================\n');
}

runBenchmark().catch(err => {
  console.error('Benchmark fatal error:', err);
  process.exit(1);
});
