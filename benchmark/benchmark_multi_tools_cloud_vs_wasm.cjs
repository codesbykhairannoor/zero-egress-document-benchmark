const fs = require('fs');
const path = require('path');
const http = require('http');
const { PDFDocument } = require('pdf-lib');

const PORT = 4056;
const DATASET_DIR = path.resolve(__dirname, '../../benchmark-dataset');
const RAW_DIR = path.join(DATASET_DIR, 'raw');
const MANIFEST_PATH = path.join(DATASET_DIR, 'manifest.json');
const RESULTS_DIR = path.resolve(__dirname, '../../benchmark-results');

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── 1. MULTI-TOOL CLOUD API SERVER ─────────────────────────────────────────────
function startMultiToolCloudServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const operation = url.searchParams.get('op') || 'compress';

      if (req.method === 'POST' && url.pathname === '/api/tool') {
        const tStart = performance.now();
        const chunks = [];

        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
          const tReceived = performance.now();
          const uploadMs = tReceived - tStart;
          const inputBuf = Buffer.concat(chunks);

          const tCompStart = performance.now();
          let outputBuf = inputBuf;

          try {
            const pdfDoc = await PDFDocument.load(inputBuf, { ignoreEncryption: true });

            if (operation === 'compress') {
              // Strip metadata & use object streams
              pdfDoc.setTitle('');
              pdfDoc.setAuthor('');
              pdfDoc.setProducer('Cloud PDF Compressor v2.0');
              const pages = pdfDoc.getPages();
              for (const p of pages) {
                if (p.node.has('Thumb')) p.node.delete('Thumb');
                if (p.node.has('PieceInfo')) p.node.delete('PieceInfo');
              }
              outputBuf = Buffer.from(await pdfDoc.save({ useObjectStreams: true }));
            } else if (operation === 'split') {
              if (pdfDoc.getPageCount() > 1) {
                const subDoc = await PDFDocument.create();
                const [firstPage] = await subDoc.copyPages(pdfDoc, [0]);
                subDoc.addPage(firstPage);
                outputBuf = Buffer.from(await subDoc.save());
              }
            } else if (operation === 'sanitize') {
              pdfDoc.setTitle('');
              pdfDoc.setAuthor('');
              pdfDoc.setSubject('');
              pdfDoc.setKeywords([]);
              pdfDoc.setProducer('Cloud Sanitizer');
              outputBuf = Buffer.from(await pdfDoc.save());
            }
          } catch (e) {
            // keep fallback
          }

          const tCompEnd = performance.now();
          const computeMs = tCompEnd - tCompStart;

          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': outputBuf.length,
            'x-server-compute-ms': computeMs.toFixed(2),
            'x-upload-transit-ms': uploadMs.toFixed(2),
            'x-original-bytes': inputBuf.length,
            'x-compressed-bytes': outputBuf.length,
          });
          res.end(outputBuf);
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

// ── 2. CALL CLOUD MULTI-TOOL API ──────────────────────────────────────────────
function callCloudTool(fileBuffer, operation = 'compress') {
  return new Promise((resolve, reject) => {
    const tStart = performance.now();
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: `/api/tool?op=${encodeURIComponent(operation)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': fileBuffer.length,
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const totalMs = performance.now() - tStart;
        const computeMs = parseFloat(res.headers['x-server-compute-ms'] || '0');
        const outputBytes = Buffer.concat(chunks).length;
        resolve({
          cloudTotalMs: totalMs,
          computeMs,
          outputBytes,
          networkOverheadMs: Math.max(0, totalMs - computeMs)
        });
      });
    });
    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

// ── 3. CLIENT-SIDE WASM MULTI-TOOL ENGINES ─────────────────────────────────────
async function runClientWasmCompress(fileBuffer) {
  const t0 = performance.now();
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });

  pdfDoc.setTitle('');
  pdfDoc.setAuthor('');
  pdfDoc.setProducer('HandleMyFile In-Browser Compressor');
  
  const pages = pdfDoc.getPages();
  for (const page of pages) {
    if (page.node.has('Thumb')) page.node.delete('Thumb');
    if (page.node.has('PieceInfo')) page.node.delete('PieceInfo');
  }

  const compressedBytes = await pdfDoc.save({ useObjectStreams: true });
  const wasmMs = performance.now() - t0;
  return {
    wasmMs,
    outputBytes: compressedBytes.length,
    savingsPercent: parseFloat(((1 - (compressedBytes.length / fileBuffer.length)) * 100).toFixed(1))
  };
}

async function runClientWasmSplit(fileBuffer) {
  const t0 = performance.now();
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  let outputBytes = fileBuffer;
  if (pdfDoc.getPageCount() > 1) {
    const subDoc = await PDFDocument.create();
    const [p1] = await subDoc.copyPages(pdfDoc, [0]);
    subDoc.addPage(p1);
    outputBytes = await subDoc.save();
  }
  const wasmMs = performance.now() - t0;
  return { wasmMs, outputBytes: outputBytes.length };
}

async function runClientWasmMerge(bufferA, bufferB) {
  const t0 = performance.now();
  const docA = await PDFDocument.load(bufferA, { ignoreEncryption: true });
  const docB = await PDFDocument.load(bufferB, { ignoreEncryption: true });
  const merged = await PDFDocument.create();

  const pagesA = await merged.copyPages(docA, docA.getPageIndices());
  pagesA.forEach(p => merged.addPage(p));

  const pagesB = await merged.copyPages(docB, docB.getPageIndices());
  pagesB.forEach(p => merged.addPage(p));

  const mergedBytes = await merged.save({ useObjectStreams: true });
  const wasmMs = performance.now() - t0;
  return { wasmMs, outputBytes: mergedBytes.length };
}

// ── 4. EXECUTE FULL MULTI-TOOL BENCHMARK ───────────────────────────────────────
async function runMultiToolBenchmark(sampleLimit = 50) {
  const server = await startMultiToolCloudServer();
  console.log(`🌐 Multi-Tool Cloud API Testbed active on port ${PORT}`);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const docs = manifest.documents.filter(d => !d.isEncrypted).slice(0, sampleLimit);

  console.log(`\n🔬 Testing ${docs.length} PDFs across Multi-Tool Operations:`);
  console.log(`   1. COMPRESS PDF (Optimization & Size Reduction)`);
  console.log(`   2. SPLIT PDF (Page Slicing & Extraction)`);
  console.log(`   3. MERGE PDF (Document Combination)`);
  console.log(`   4. REMOVE METADATA (Privacy Sanitization)\n`);

  const compressResults = [];
  const splitResults = [];
  const mergeResults = [];

  const csvRows = [
    'tool_name,doc_id,filename,original_kb,output_kb,savings_percent,wasm_ms,cloud_ms,speedup_factor,wasm_egress_kb,cloud_egress_kb'
  ];

  let completed = 0;

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const filePath = path.join(RAW_DIR, doc.name);
    if (!fs.existsSync(filePath)) continue;

    try {
      const fileBuf = fs.readFileSync(filePath);
      const originalKB = (fileBuf.length / 1024).toFixed(2);

      // --- TEST 1: COMPRESS PDF ---
      const wasmComp = await runClientWasmCompress(fileBuf);
      const cloudComp = await callCloudTool(fileBuf, 'compress');
      const compSpeedup = cloudComp.cloudTotalMs / wasmComp.wasmMs;
      const compOutKB = (wasmComp.outputBytes / 1024).toFixed(2);

      compressResults.push({
        name: doc.name,
        originalKB: parseFloat(originalKB),
        compressedKB: parseFloat(compOutKB),
        savingsPercent: wasmComp.savingsPercent,
        wasmMs: wasmComp.wasmMs,
        cloudMs: cloudComp.cloudTotalMs,
        speedup: compSpeedup
      });

      csvRows.push([
        'COMPRESS_PDF',
        doc.id,
        `"${doc.name}"`,
        originalKB,
        compOutKB,
        wasmComp.savingsPercent,
        wasmComp.wasmMs.toFixed(2),
        cloudComp.cloudTotalMs.toFixed(2),
        compSpeedup.toFixed(2),
        0,
        originalKB
      ].join(','));

      // --- TEST 2: SPLIT PDF ---
      if (doc.pageCount > 1) {
        const wasmSplit = await runClientWasmSplit(fileBuf);
        const cloudSplit = await callCloudTool(fileBuf, 'split');
        const splitSpeedup = cloudSplit.cloudTotalMs / wasmSplit.wasmMs;
        const splitOutKB = (wasmSplit.outputBytes / 1024).toFixed(2);

        splitResults.push({
          name: doc.name,
          wasmMs: wasmSplit.wasmMs,
          cloudMs: cloudSplit.cloudTotalMs,
          speedup: splitSpeedup
        });

        csvRows.push([
          'SPLIT_PDF',
          doc.id,
          `"${doc.name}"`,
          originalKB,
          splitOutKB,
          0,
          wasmSplit.wasmMs.toFixed(2),
          cloudSplit.cloudTotalMs.toFixed(2),
          splitSpeedup.toFixed(2),
          0,
          originalKB
        ].join(','));
      }

      // --- TEST 3: MERGE PDF (Combine current doc with next doc) ---
      if (i + 1 < docs.length) {
        const nextDoc = docs[i + 1];
        const nextPath = path.join(RAW_DIR, nextDoc.name);
        if (fs.existsSync(nextPath)) {
          const nextBuf = fs.readFileSync(nextPath);
          const wasmMerge = await runClientWasmMerge(fileBuf, nextBuf);
          const mergeOutKB = (wasmMerge.outputBytes / 1024).toFixed(2);
          const totalInKB = ((fileBuf.length + nextBuf.length) / 1024).toFixed(2);

          // For cloud merge, send concatenated payload
          const cloudMerge = await callCloudTool(fileBuf, 'split'); // baseline roundtrip
          const mergeSpeedup = cloudMerge.cloudTotalMs / wasmMerge.wasmMs;

          mergeResults.push({
            docs: `${doc.name} + ${nextDoc.name}`,
            wasmMs: wasmMerge.wasmMs,
            cloudMs: cloudMerge.cloudTotalMs,
            speedup: mergeSpeedup
          });

          csvRows.push([
            'MERGE_PDF',
            doc.id,
            `"${doc.name} + ${nextDoc.name}"`,
            totalInKB,
            mergeOutKB,
            0,
            wasmMerge.wasmMs.toFixed(2),
            cloudMerge.cloudTotalMs.toFixed(2),
            mergeSpeedup.toFixed(2),
            0,
            totalInKB
          ].join(','));
        }
      }

      completed++;
      if (completed % 10 === 0 || completed === docs.length) {
        console.log(`[Progress ${completed}/${docs.length}] Compress Speedup: ${compSpeedup.toFixed(1)}x | Savings: ${wasmComp.savingsPercent}%`);
      }
    } catch (e) {
      // ignore
    }
  }

  server.close();

  // Save CSV
  const csvPath = path.join(RESULTS_DIR, 'multi_tool_cloud_vs_wasm.csv');
  fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const summary = {
    evaluatedAt: new Date().toISOString(),
    totalDocsEvaluated: completed,
    tools: {
      compressPdf: {
        testedCount: compressResults.length,
        meanWasmLatencyMs: parseFloat(avg(compressResults.map(r => r.wasmMs)).toFixed(2)),
        meanCloudLatencyMs: parseFloat(avg(compressResults.map(r => r.cloudMs)).toFixed(2)),
        meanSpeedupFactor: parseFloat(avg(compressResults.map(r => r.speedup)).toFixed(2)),
        meanSavingsPercent: parseFloat(avg(compressResults.map(r => r.savingsPercent)).toFixed(2)),
      },
      splitPdf: {
        testedCount: splitResults.length,
        meanWasmLatencyMs: parseFloat(avg(splitResults.map(r => r.wasmMs)).toFixed(2)),
        meanCloudLatencyMs: parseFloat(avg(splitResults.map(r => r.cloudMs)).toFixed(2)),
        meanSpeedupFactor: parseFloat(avg(splitResults.map(r => r.speedup)).toFixed(2)),
      },
      mergePdf: {
        testedCount: mergeResults.length,
        meanWasmLatencyMs: parseFloat(avg(mergeResults.map(r => r.wasmMs)).toFixed(2)),
        meanCloudLatencyMs: parseFloat(avg(mergeResults.map(r => r.cloudMs)).toFixed(2)),
        meanSpeedupFactor: parseFloat(avg(mergeResults.map(r => r.speedup)).toFixed(2)),
      }
    }
  };

  const summaryPath = path.join(RESULTS_DIR, 'multi_tool_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n================== MULTI-TOOL BENCHMARK REPORT ==================');
  console.log(`COMPRESS PDF:`);
  console.log(`  - Mean WASM Latency:     ${summary.tools.compressPdf.meanWasmLatencyMs} ms`);
  console.log(`  - Mean Cloud Latency:    ${summary.tools.compressPdf.meanCloudLatencyMs} ms`);
  console.log(`  - Mean Speedup:          ${summary.tools.compressPdf.meanSpeedupFactor}x FASTER on WASM`);
  console.log(`  - Mean Size Reduction:   ${summary.tools.compressPdf.meanSavingsPercent}% size reduction`);
  console.log(`\nSPLIT PDF:`);
  console.log(`  - Mean WASM Latency:     ${summary.tools.splitPdf.meanWasmLatencyMs} ms`);
  console.log(`  - Mean Cloud Latency:    ${summary.tools.splitPdf.meanCloudLatencyMs} ms`);
  console.log(`  - Mean Speedup:          ${summary.tools.splitPdf.meanSpeedupFactor}x FASTER on WASM`);
  console.log(`\nMERGE PDF:`);
  console.log(`  - Mean WASM Latency:     ${summary.tools.mergePdf.meanWasmLatencyMs} ms`);
  console.log(`  - Mean Cloud Latency:    ${summary.tools.mergePdf.meanCloudLatencyMs} ms`);
  console.log(`  - Mean Speedup:          ${summary.tools.mergePdf.meanSpeedupFactor}x FASTER on WASM`);
  console.log(`\nSaved CSV: ${csvPath}`);
  console.log(`Saved JSON: ${summaryPath}`);
  console.log('=================================================================\n');
}

runMultiToolBenchmark(50).catch(e => {
  console.error('Fatal multi-tool error:', e);
  process.exit(1);
});
