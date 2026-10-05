const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// KONFIGURASI
// ============================================
const TEMP_DIR = path.join(__dirname, 'temp');
const BACKUP_DIR = path.join(__dirname, 'backup');
const PRINTER_NAME = 'POS58';
const MAX_RETRY = 2;
const PRINT_TIMEOUT = 20000; // 20 detik
const RESET_PRINTER_ON_STUCK = true;

// Interval monitoring (ms)
const MONITOR_INTERVAL     = 60_000;    // cek tiap 60 detik
const QUEUE_STUCK_THRESHOLD = 60_000;   // queue diam > 60s → recover
const HEALTH_CHECK_IDLE     = 300_000;  // idle > 5 menit → silent check

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// ============================================
// STATE
// ============================================
let isPrinting = false;
let printQueue = [];
let currentPrinter = PRINTER_NAME;
let printerReady = false;
let psProcess = null;
let psRestartCount = 0;
let lastPrintTime = 0;
let lastActivity = Date.now();  // ← update tiap print sukses
const MIN_PRINT_INTERVAL = 500;

// ============================================
// RESET PRINTER (Clear stuck jobs)
// ============================================
function resetPrinter() {
    return new Promise((resolve) => {
        console.log('🔄 Resetting printer...');

        try {
            execSync('Get-PrintJob -PrinterName "' + PRINTER_NAME + '" | Remove-PrintJob -ErrorAction SilentlyContinue', {
                shell: 'powershell',
                timeout: 5000
            });
            console.log('  ✓ Print jobs cleared');
        } catch (e) {
            console.log('  ⚠ No jobs to clear');
        }

        if (RESET_PRINTER_ON_STUCK) {
            try {
                execSync('Restart-Service -Name Spooler -Force', {
                    shell: 'powershell',
                    timeout: 10000
                });
                console.log('  ✓ Print spooler restarted');
            } catch (e) {
                console.log('  ⚠ Cannot restart spooler (admin required)');
            }
        }

        setTimeout(() => {
            console.log('  ✓ Printer reset complete');
            resolve(true);
        }, 2000);
    });
}

// ============================================
// CLEAR PRINTER (via WMI)
// ============================================
function clearPrinterJobs() {
    try {
        const cmd = `
            $printer = "${PRINTER_NAME}"
            Get-WmiObject -Query "SELECT * FROM Win32_PrintJob WHERE Name LIKE '%$printer%'" |
            ForEach-Object { $_.Delete() }
        `;
        execSync(cmd, { shell: 'powershell', timeout: 5000 });
        console.log('  ✓ Printer jobs purged via WMI');
    } catch (e) {
        // Silently ignore
    }
}

// ============================================
// POWERSHELL SESSION MANAGEMENT
// ============================================
function killPowerShell() {
    if (psProcess) {
        try {
            psProcess.stdin.end();
            psProcess.kill('SIGKILL');
        } catch (e) {}
        psProcess = null;
    }
}

function initPowerShell() {
    return new Promise((resolve) => {
        killPowerShell();
        clearPrinterJobs();

        setTimeout(() => {
            psProcess = spawn('powershell', [
                '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            let buffer = '';
            let resolved = false;

            const initCommands = `
                Add-Type -AssemblyName System.Drawing
                $printer = "${PRINTER_NAME}"

                $doc = New-Object System.Drawing.Printing.PrintDocument
                $doc.PrinterSettings.PrinterName = $printer

                if ($doc.PrinterSettings.IsValid) {
                    Write-Output "PRINTER_READY:$printer"
                } else {
                    Write-Output "PRINTER_ERROR:$printer"
                }
                $doc.Dispose()
            `;

            const stderrHandler = (data) => {
                const msg = data.toString();
                if (!msg.includes('Exception calling "Print"') &&
                    !msg.includes('PrintDocument') &&
                    !msg.includes('at System.Drawing')) {
                    console.error('PS Stderr:', msg);
                }
            };

            psProcess.stderr.on('data', stderrHandler);

            const dataHandler = (data) => {
                if (resolved) return;
                buffer += data.toString();

                if (buffer.includes('PRINTER_READY:')) {
                    resolved = true;
                    currentPrinter = buffer.split('PRINTER_READY:')[1].split('\n')[0].trim();
                    printerReady = true;
                    psRestartCount = 0;
                    console.log(`✅ Printer ready: ${currentPrinter}`);
                    psProcess.stdout.removeListener('data', dataHandler);
                    resolve(true);
                }

                if (buffer.includes('PRINTER_ERROR:')) {
                    resolved = true;
                    printerReady = false;
                    console.error('❌ Printer not found');
                    psProcess.stdout.removeListener('data', dataHandler);
                    resolve(false);
                }
            };

            psProcess.stdout.on('data', dataHandler);

            psProcess.on('close', (code) => {
                printerReady = false;
                psProcess = null;

                if (!resolved) {
                    resolved = true;
                    resolve(false);
                }

                console.log(`⚠ PowerShell closed (code: ${code})`);

                const delay = Math.min(psRestartCount * 2000, 10000);
                psRestartCount++;
                console.log(`  Restarting in ${delay / 1000}s...`);

                setTimeout(async () => {
                    await initPowerShell();
                }, delay);
            });

            psProcess.on('error', (err) => {
                console.error('PS Error:', err.message);
                if (!resolved) {
                    resolved = true;
                    resolve(false);
                }
            });

            psProcess.stdin.write(initCommands + '\n');

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    console.error('⏱ PS init timeout');
                    psProcess.stdout.removeListener('data', dataHandler);
                    killPowerShell();
                    resolve(false);
                }
            }, 15000);
        }, 1000);
    });
}

// ============================================
// RECOVER PRINTER (full reset cycle)
// ============================================
async function recoverPrinter() {
    console.log('🔄 Starting printer recovery...');

    killPowerShell();
    clearPrinterJobs();
    await resetPrinter();

    await new Promise(r => setTimeout(r, 3000));

    const result = await initPowerShell();

    if (result) {
        console.log('✅ Printer recovered successfully');
    } else {
        console.error('❌ Printer recovery failed');
    }

    return result;
}

// ============================================
// SILENT PRINTER CHECK — tanpa cetak fisik
// ============================================
function silentPrinterCheck() {
    return new Promise((resolve) => {
        try {
            // Cek 1: printer masih terdaftar
            const out = execSync(
                `powershell -NoProfile -Command "Get-Printer -Name '${PRINTER_NAME}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name"`,
                { timeout: 5000, encoding: 'utf8' }
            );

            if (!out || !out.trim()) {
                return resolve(false);
            }

            // Cek 2: spooler service hidup
            const spool = execSync(
                `powershell -NoProfile -Command "(Get-Service -Name Spooler).Status"`,
                { timeout: 5000, encoding: 'utf8' }
            ).trim();

            resolve(spool === 'Running');
        } catch (e) {
            resolve(false);
        }
    });
}

// ============================================
// PRINT QUEUE PROCESSOR
// ============================================
async function processPrintQueue() {
    if (isPrinting || printQueue.length === 0) return;

    const timeSinceLastPrint = Date.now() - lastPrintTime;
    if (timeSinceLastPrint < MIN_PRINT_INTERVAL) {
        setTimeout(() => processPrintQueue(), MIN_PRINT_INTERVAL - timeSinceLastPrint);
        return;
    }

    isPrinting = true;
    const job = printQueue.shift();

    try {
        const result = await executePrintWithRetry(job);
        lastPrintTime = Date.now();
        lastActivity  = Date.now();   // ← update aktivitas
        job.resolve(result);
    } catch (error) {
        console.error(`❌ Job failed: ${error.message}`);

        if (error.message.includes('stuck') || error.message.includes('timeout')) {
            console.log('🔄 Recovering printer...');
            await recoverPrinter();
            printQueue.unshift(job);
        } else {
            job.reject(error);
        }
    } finally {
        isPrinting = false;
        if (printQueue.length > 0) {
            setTimeout(() => processPrintQueue(), MIN_PRINT_INTERVAL);
        }
    }
}

function queuePrint(job) {
    return new Promise((resolve, reject) => {
        printQueue.push({ ...job, resolve, reject, queuedAt: Date.now() });
        processPrintQueue();
    });
}

// ============================================
// EXECUTE PRINT WITH RETRY
// ============================================
async function executePrintWithRetry(job, attempt = 1) {
    try {
        return await executePrint(job);
    } catch (error) {
        if (attempt < MAX_RETRY) {
            console.log(`⚠ Retry ${attempt}/${MAX_RETRY} for ${job.invoice}`);

            killPowerShell();
            clearPrinterJobs();
            await new Promise(r => setTimeout(r, 2000));
            await initPowerShell();
            await new Promise(r => setTimeout(r, 1000));

            return executePrintWithRetry(job, attempt + 1);
        }
        throw error;
    }
}

// ============================================
// EXECUTE PRINT (Text-Only — CASH & QRIS sama)
// ============================================
function executePrint(job) {
    return new Promise((resolve, reject) => {
        if (!printerReady || !psProcess || psProcess.killed) {
            console.log('⚠ Printer not ready, restarting PS...');
            return reject(new Error('Printer not ready - restarting'));
        }

        const { text, invoice } = job;
        const printId = `P_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

        const txtFile = path.join(TEMP_DIR, `txt-${printId}.txt`);

        try {
            fs.writeFileSync(txtFile, text, 'utf8');
        } catch (e) {
            return reject(new Error(`File error: ${e.message}`));
        }

        const txtPath = txtFile.replace(/\\/g, '\\\\');

        const command = `
            $ErrorActionPreference = "Stop"
            try {
                Add-Type -AssemblyName System.Drawing

                $txt = Get-Content "${txtPath}" -Raw -ErrorAction Stop
                $f = New-Object System.Drawing.Font("Courier New", 8)
                $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)

                $d = New-Object System.Drawing.Printing.PrintDocument
                $d.PrinterSettings.PrinterName = "${currentPrinter}"
                $d.DocumentName = "Receipt"

                $d.Add_PrintPage({
                    $r = New-Object System.Drawing.RectangleF(5, 5, 220, 800)
                    $_.Graphics.DrawString($txt, $f, $b, $r)
                    $_.HasMorePages = $false
                })

                $d.Print()
                $d.Dispose()
                $f.Dispose()
                $b.Dispose()

                Remove-Item "${txtPath}" -Force -ErrorAction SilentlyContinue

                Write-Output "${printId}:OK"
            } catch {
                $errMsg = $_.Exception.Message
                if ($d) { try { $d.Dispose() } catch {} }
                if ($f) { try { $f.Dispose() } catch {} }
                if ($b) { try { $b.Dispose() } catch {} }
                Write-Output "${printId}:ERR:$errMsg"
            }
        `;

        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error(`Print timeout (${PRINT_TIMEOUT / 1000}s) - printer may be stuck`));
            }, PRINT_TIMEOUT);
        });

        const responsePromise = new Promise((resolve, reject) => {
            const handler = (data) => {
                const response = data.toString();

                if (response.includes(`${printId}:OK`)) {
                    clearTimeout(timeoutId);
                    psProcess.stdout.removeListener('data', handler);
                    cleanup();
                    resolve({ success: true, printId });
                }

                if (response.includes(`${printId}:ERR:`)) {
                    const errorMsg = response.split(`${printId}:ERR:`)[1].split('\n')[0].trim();
                    clearTimeout(timeoutId);
                    psProcess.stdout.removeListener('data', handler);
                    cleanup();

                    if (errorMsg.includes('timed out') || errorMsg.includes('not ready')) {
                        reject(new Error(`Printer stuck: ${errorMsg}`));
                    } else {
                        reject(new Error(errorMsg));
                    }
                }
            };

            psProcess.stdout.on('data', handler);
        });

        try {
            psProcess.stdin.write(command + '\n');
        } catch (e) {
            clearTimeout(timeoutId);
            cleanup();
            return reject(new Error(`Cannot write to PS: ${e.message}`));
        }

        Promise.race([responsePromise, timeoutPromise])
            .then(resolve)
            .catch(reject);

        function cleanup() {
            setTimeout(() => {
                try { if (fs.existsSync(txtFile)) fs.unlinkSync(txtFile); } catch (e) {}
            }, 1000);
        }
    });
}

// ============================================
// GENERATE RECEIPT TEXT (CASH & QRIS sama)
// ============================================
function generateReceiptText(data) {
    let text = '';

    text += '        KOPERASI STANLEY\n';
    text += ' PT INDONESIA STANLEY ELECTRIC\n';
    text += '   Telp : 0822-6000-9636\n';
    text += '================================\n';

    text += `Invoice : ${data.invoice}\n`;
    text += `Date    : ${data.date}\n`;
    text += `Cashier : ${data.cashier || 'Admin'}\n`;
    text += `Payment : ${data.payment.toUpperCase()}\n`;
    text += '================================\n';

    data.items.forEach(item => {
        const price = item.price.toLocaleString('id-ID');
        const subtotal = item.subtotal.toLocaleString('id-ID');
        text += `${item.name}\n`;
        text += `  ${item.qty} x ${price}     ${subtotal}\n`;
    });

    text += '================================\n';

    const fmt = (num) => num.toLocaleString('id-ID');
    text += `Subtotal : ${fmt(data.subtotal)}\n`;
    if (data.discount > 0) text += `Discount : ${fmt(data.discount)}\n`;
    text += `TOTAL    : ${fmt(data.total)}\n`;
    text += `Bayar    : ${fmt(data.pay)}\n`;
    if (data.change > 0) text += `Kembali  : ${fmt(data.change)}\n`;

    text += '================================\n';

    if (data.member) {
        text += `Member   : ${data.member.name}\n`;
        text += `Cashback : ${fmt(data.member.cashback)}\n`;
        text += '================================\n';
    }

    text += '\n         TERIMA KASIH\n';
    text += '   BELANJA ANDA GRATIS\n';
    text += ' JIKA TIDAK MENERIMA STRUK\n';
    text += '\n  www.koperasi-stanley.com\n';
    text += '\n';

    return text;
}

// ============================================
// ROUTES
// ============================================
app.post('/print', async (req, res) => {
    const start = Date.now();

    try {
        const { receipt, qr_image } = req.body;
        const text = generateReceiptText(receipt);

        // Backup struk (text)
        const backupFile = path.join(BACKUP_DIR, `receipt-${receipt.invoice}.txt`);
        fs.writeFile(backupFile, text, 'utf8', () => {});

        // Backup QR image (kalau ada) — arsip saja, TIDAK dicetak
        if (receipt.payment.toUpperCase() === 'QRIS' && qr_image) {
            const qrBackupFile = path.join(BACKUP_DIR, `qr-${receipt.invoice}.png`);
            fs.writeFile(qrBackupFile, Buffer.from(qr_image, 'base64'), () => {});
        }

        res.json({
            success: true,
            message: 'Receipt queued',
            invoice: receipt.invoice,
            queue: printQueue.length,
            elapsed: (Date.now() - start) + 'ms'
        });

        queuePrint({
            text,
            invoice: receipt.invoice
        })
        .then(() => console.log(`✅ Printed: ${receipt.invoice} (${Date.now() - start}ms)`))
        .catch(err => console.error(`❌ ${receipt.invoice}: ${err.message}`));

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/reprint', async (req, res) => {
    try {
        const { receipt } = req.body;
        const text = generateReceiptText(receipt);

        clearPrinterJobs();
        await new Promise(r => setTimeout(r, 1000));

        await executePrint({
            text,
            invoice: receipt.invoice + '-REPRINT'
        });

        lastActivity = Date.now();
        res.json({ success: true, message: 'Reprint success' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Manual reset endpoint
app.post('/reset-printer', async (req, res) => {
    console.log('🔧 Manual printer reset requested');
    await recoverPrinter();
    lastActivity = Date.now();
    res.json({
        success: printerReady,
        printer: currentPrinter,
        ready: printerReady
    });
});

// Clear queue
app.post('/clear-queue', (req, res) => {
    const count = printQueue.length;
    printQueue = [];
    res.json({ success: true, cleared: count });
});

app.get('/status', (req, res) => {
    res.json({
        printer: {
            ready: printerReady,
            name: currentPrinter,
            printing: isPrinting,
            queue: printQueue.length,
            lastPrint: lastPrintTime ? new Date(lastPrintTime).toISOString() : null,
            lastActivity: new Date(lastActivity).toISOString()
        },
        uptime: process.uptime()
    });
});

app.get('/test', async (req, res) => {
    const testData = {
        invoice: 'TEST-' + Date.now(),
        date: new Date().toLocaleString('id-ID'),
        cashier: 'Admin',
        payment: 'CASH',
        subtotal: 15000,
        discount: 0,
        total: 15000,
        pay: 20000,
        change: 5000,
        charge: 0,
        items: [{ name: 'Coca Cola', qty: 2, price: 5000, subtotal: 10000 }],
        member: null
    };

    const text = generateReceiptText(testData);

    try {
        await executePrint({ text, invoice: testData.invoice });
        lastActivity = Date.now();
        console.log('✅ Test print OK');
        res.json({ success: true, printer: currentPrinter, ready: printerReady });
    } catch (e) {
        console.error('❌ Test failed:', e.message);
        await recoverPrinter();
        res.status(500).json({
            success: false,
            error: e.message,
            recovered: printerReady
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: printerReady ? 'ok' : 'no_printer',
        printer: currentPrinter,
        printing: isPrinting,
        queue: printQueue.length,
        psAlive: psProcess && !psProcess.killed,
        lastActivity: new Date(lastActivity).toISOString()
    });
});

// ============================================
// MONITORING — Silent check, TIDAK cetak fisik
// ============================================
setInterval(async () => {
    const idleTime = Date.now() - lastActivity;

    // (a) Queue stuck: ada job tapi tidak diproses
    if (printQueue.length > 0 && !isPrinting && idleTime > QUEUE_STUCK_THRESHOLD) {
        console.log('⚠ Queue stuck detected, recovering...');
        await recoverPrinter();
        lastActivity = Date.now();
        processPrintQueue();
        return;
    }

    // (b) Silent health check — cek printer tanpa cetak
    if (idleTime > HEALTH_CHECK_IDLE && printerReady) {
        console.log('🔍 Silent health check...');

        const ok = await silentPrinterCheck();

        if (!ok) {
            console.log('⚠ Printer tidak sehat, recovering...');
            await recoverPrinter();
        } else {
            console.log('✅ Printer sehat');
        }

        lastActivity = Date.now();
    }
}, MONITOR_INTERVAL);

// ============================================
// STARTUP
// ============================================
async function startServer() {
    console.log('========================================');
    console.log('  Koperasi Stanley - Print Server');
    console.log('  Mode: Anti-Stuck + Silent Health Check');
    console.log('========================================');

    console.log('Initializing printer...');
    await initPowerShell();

    app.listen(3000, '0.0.0.0', () => {
        console.log('========================================');
        console.log(`  Printer : ${currentPrinter}`);
        console.log(`  Status  : ${printerReady ? '✅ READY' : '❌ ERROR'}`);
        console.log(`  Retry   : ${MAX_RETRY}x`);
        console.log(`  Timeout : ${PRINT_TIMEOUT / 1000}s`);
        console.log(`  Port    : 3000`);
        console.log('========================================');
    });
}

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    killPowerShell();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    killPowerShell();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled rejection:', reason);
});