// // server.js - Fixed: Print conflict issue
// const express = require('express');
// const cors = require('cors');
// const fs = require('fs');
// const path = require('path');
// const { spawn } = require('child_process');
// const app = express();

// app.use(cors());
// app.use(express.json({ limit: '10mb' }));

// // ============================================
// // KONFIGURASI
// // ============================================
// const TEMP_DIR = path.join(__dirname, 'temp');
// const BACKUP_DIR = path.join(__dirname, 'backup');

// if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
// if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// // ============================================
// // LOCK MECHANISM (untuk mencegah print bersamaan)
// // ============================================
// let isPrinting = false;
// let printQueue = [];
// let currentPrinter = 'POS58';
// let printerReady = false;

// // ============================================
// // POWERSHELL SESSION - SATU INSTANCE SAJA
// // ============================================
// let psProcess = null;

// function initPowerShell() {
//     return new Promise((resolve) => {
//         if (psProcess) {
//             try { psProcess.kill(); } catch(e) {}
//         }
        
//         psProcess = spawn('powershell', ['-NoLogo', '-NoProfile', '-Command', '-'], {
//             stdio: ['pipe', 'pipe', 'pipe']
//         });

//         const initCommands = `
//             Add-Type -AssemblyName System.Drawing
//             $printer = "POS58"
            
//             # Validasi printer
//             $doc = New-Object System.Drawing.Printing.PrintDocument
//             $doc.PrinterSettings.PrinterName = $printer
            
//             if ($doc.PrinterSettings.IsValid) {
//                 Write-Output "PRINTER_READY:POS58"
//             } else {
//                 Write-Output "PRINTER_ERROR"
//             }
//             $doc.Dispose()
//         `;

//         psProcess.stdin.write(initCommands + '\n');

//         let buffer = '';
//         const onData = (data) => {
//             buffer += data.toString();
//             if (buffer.includes('PRINTER_READY:')) {
//                 currentPrinter = buffer.split('PRINTER_READY:')[1].trim();
//                 printerReady = true;
//                 console.log(`✓ Printer ready: ${currentPrinter}`);
//                 psProcess.stdout.removeListener('data', onData);
//                 resolve(true);
//             }
//             if (buffer.includes('PRINTER_ERROR')) {
//                 console.error('✗ Printer not found');
//                 printerReady = false;
//                 psProcess.stdout.removeListener('data', onData);
//                 resolve(false);
//             }
//         };

//         psProcess.stdout.on('data', onData);

//         psProcess.stderr.on('data', (d) => {
//             // Hanya log error yang bukan dari print (error print ditangani sendiri)
//             if (!d.toString().includes('Exception calling "Print"')) {
//                 console.error('PS:', d.toString());
//             }
//         });
        
//         psProcess.on('close', (code) => {
//             printerReady = false;
//             console.log(`PowerShell closed (code: ${code}), restarting in 3s...`);
//             setTimeout(() => initPowerShell(), 3000);
//         });

//         // Timeout 10 detik
//         setTimeout(() => {
//             if (!printerReady) {
//                 console.log('PowerShell init timeout');
//                 resolve(false);
//             }
//         }, 10000);
//     });
// }

// // ============================================
// // PRINT QUEUE PROCESSOR
// // ============================================
// async function processPrintQueue() {
//     if (isPrinting || printQueue.length === 0) return;
    
//     isPrinting = true;
//     const job = printQueue.shift();
    
//     try {
//         const result = await executePrint(job);
//         job.resolve(result);
//     } catch (error) {
//         job.reject(error);
//     } finally {
//         isPrinting = false;
//         // Process next job if any
//         if (printQueue.length > 0) {
//             setTimeout(() => processPrintQueue(), 100); // Delay kecil antar print
//         }
//     }
// }

// function queuePrint(job) {
//     return new Promise((resolve, reject) => {
//         printQueue.push({ ...job, resolve, reject });
//         processPrintQueue();
//     });
// }

// // ============================================
// // EXECUTE PRINT - QR CENTERED & SMALLER
// // ============================================
// function executePrint(job) {
//     return new Promise((resolve, reject) => {
//         if (!printerReady || !psProcess || psProcess.killed) {
//             return reject(new Error('Printer not ready'));
//         }

//         const { text, qrImageBase64, invoice } = job;
//         const printId = `PRINT_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
//         // Buat file temporary
//         const txtFile = path.join(TEMP_DIR, `r-${printId}.txt`);
//         fs.writeFileSync(txtFile, text, 'utf8');
        
//         let command = '';
        
//         if (qrImageBase64) {
//             // Print dengan QR code
//             const qrFile = path.join(TEMP_DIR, `qr-${printId}.png`);
//             const buffer = Buffer.from(qrImageBase64, 'base64');
//             fs.writeFileSync(qrFile, buffer);
            
//             const txtPath = txtFile.replace(/\\/g, '\\\\');
//             const qrPath = qrFile.replace(/\\/g, '\\\\');
            
//             command = `
//                 try {
//                     # Load resources
//                     $txt = Get-Content "${txtPath}" -Raw
//                     $f = New-Object System.Drawing.Font("Courier New", 8)
//                     $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
//                     $qr = [System.Drawing.Image]::FromFile("${qrPath}")
                    
//                     # Paper size (58mm = 220px)
//                     $paperWidth = 220
                    
//                     # QR SIZE - LEBIH KECIL
//                     $qrSize = 160
                    
//                     # HITUNG POSISI X SUPAYA CENTER
//                     $qrX = [Math]::Floor(($paperWidth - $qrSize) / 2)
                    
//                     # HITUNG TINGGI TEXT
//                     $measureBmp = New-Object System.Drawing.Bitmap(1, 1)
//                     $measureGfx = [System.Drawing.Graphics]::FromImage($measureBmp)
//                     $measureFont = New-Object System.Drawing.Font("Courier New", 8)
//                     $measureRect = New-Object System.Drawing.RectangleF(0, 0, 210, 2000)
//                     $textSize = $measureGfx.MeasureString($txt, $measureFont, $measureRect.Size)
//                     $textHeight = [Math]::Ceiling($textSize.Height) + 10
//                     $measureGfx.Dispose()
//                     $measureBmp.Dispose()
//                     $measureFont.Dispose()
                    
//                     # Posisi Y setelah text + padding
//                     $qrY = $textHeight + 20
                    
//                     # Create document
//                     $d = New-Object System.Drawing.Printing.PrintDocument
//                     $d.PrinterSettings.PrinterName = "${currentPrinter}"
//                     $d.DocumentName = "Receipt-QRIS"
                    
//                     $d.Add_PrintPage({
//                         # Draw text - SAMA PERSIS DENGAN NON-QRIS
//                         $textRect = New-Object System.Drawing.RectangleF(5, 5, 220, 800)
//                         $_.Graphics.DrawString($txt, $f, $b, $textRect)
                        
//                         # Draw QR code CENTER
//                         $qrRect = New-Object System.Drawing.Rectangle($qrX, $qrY, $qrSize, $qrSize)
//                         $_.Graphics.DrawImage($qr, $qrRect)
                        
//                         $_.HasMorePages = $false
//                     })
                    
//                     $d.Print()
                    
//                     # Cleanup
//                     $d.Dispose()
//                     $f.Dispose()
//                     $b.Dispose()
//                     $qr.Dispose()
                    
//                     # Remove temp files
//                     Remove-Item "${txtPath}" -Force -ErrorAction SilentlyContinue
//                     Remove-Item "${qrPath}" -Force -ErrorAction SilentlyContinue
                    
//                     Write-Output "${printId}:SUCCESS"
//                 } catch {
//                     Write-Output "${printId}:ERROR:$($_.Exception.Message)"
//                     if ($d) { $d.Dispose() }
//                     if ($f) { $f.Dispose() }
//                     if ($b) { $b.Dispose() }
//                     if ($qr) { $qr.Dispose() }
//                 }
//             `;
            
//         } else {
//             // Print text saja
//             const txtPath = txtFile.replace(/\\/g, '\\\\');
            
//             command = `
//                 try {
//                     $txt = Get-Content "${txtPath}" -Raw
//                     $f = New-Object System.Drawing.Font("Courier New", 8)
//                     $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
                    
//                     $d = New-Object System.Drawing.Printing.PrintDocument
//                     $d.PrinterSettings.PrinterName = "${currentPrinter}"
//                     $d.DocumentName = "Receipt"
                    
//                     $d.Add_PrintPage({
//                         $r = New-Object System.Drawing.RectangleF(5, 5, 220, 800)
//                         $_.Graphics.DrawString($txt, $f, $b, $r)
//                         $_.HasMorePages = $false
//                     })
                    
//                     $d.Print()
                    
//                     # Cleanup
//                     $d.Dispose()
//                     $f.Dispose()
//                     $b.Dispose()
                    
//                     Remove-Item "${txtPath}" -Force -ErrorAction SilentlyContinue
                    
//                     Write-Output "${printId}:SUCCESS"
//                 } catch {
//                     Write-Output "${printId}:ERROR:$($_.Exception.Message)"
//                     if ($d) { $d.Dispose() }
//                     if ($f) { $f.Dispose() }
//                     if ($b) { $b.Dispose() }
//                 }
//             `;
//         }
        
//         // Set timeout
//         const timeout = setTimeout(() => {
//             cleanup();
//             reject(new Error('Print timeout'));
//         }, 15000);
        
//         // Listener untuk response
//         const onData = (data) => {
//             const response = data.toString();
            
//             if (response.includes(`${printId}:SUCCESS`)) {
//                 clearTimeout(timeout);
//                 psProcess.stdout.removeListener('data', onData);
//                 cleanup();
//                 resolve({ success: true, printId });
//             }
            
//             if (response.includes(`${printId}:ERROR:`)) {
//                 const errorMsg = response.split(`${printId}:ERROR:`)[1].trim();
//                 clearTimeout(timeout);
//                 psProcess.stdout.removeListener('data', onData);
//                 cleanup();
//                 reject(new Error(errorMsg));
//             }
//         };
        
//         psProcess.stdout.on('data', onData);
//         psProcess.stdin.write(command + '\n');
        
//         function cleanup() {
//             setTimeout(() => {
//                 try { fs.unlinkSync(txtFile); } catch(e) {}
//                 if (qrImageBase64) {
//                     const qrFile = path.join(TEMP_DIR, `qr-${printId}.png`);
//                     try { fs.unlinkSync(qrFile); } catch(e) {}
//                 }
//             }, 500);
//         }
//     });
// }

// // ============================================
// // GENERATE RECEIPT TEXT
// // ============================================
// function generateReceiptText(data) {
//     let text = '';
    
//     text += '        KOPERASI STANLEY\n';
//     text += ' PT INDONESIA STANLEY ELECTRIC\n';
//     text += '   Telp : 0822-6000-9636\n';
//     text += '================================\n';
    
//     text += `Invoice : ${data.invoice}\n`;
//     text += `Date    : ${data.date}\n`;
//     text += `Cashier : ${data.cashier || 'Admin'}\n`;
//     text += `Payment : ${data.payment.toUpperCase()}\n`;
//     text += '================================\n';
    
//     data.items.forEach(item => {
//         const price = item.price.toLocaleString('id-ID');
//         const subtotal = item.subtotal.toLocaleString('id-ID');
//         text += `${item.name}\n`;
//         text += `  ${item.qty} x ${price}     ${subtotal}\n`;
//     });
    
//     text += '================================\n';
    
//     const fmt = (num) => num.toLocaleString('id-ID');
//     text += `Subtotal : ${fmt(data.subtotal)}\n`;
//     if (data.discount > 0) text += `Discount : ${fmt(data.discount)}\n`;
//     text += `TOTAL    : ${fmt(data.total)}\n`;
//     text += `Bayar    : ${fmt(data.pay)}\n`;
//     if (data.change > 0) text += `Kembali  : ${fmt(data.change)}\n`;
    
//     text += '================================\n';
    
//     if (data.member) {
//         text += `Member   : ${data.member.name}\n`;
//         text += `Cashback : ${fmt(data.member.cashback)}\n`;
//         text += '================================\n';
//     }
    
//     text += '\n         TERIMA KASIH\n';
//     text += '   BELANJA ANDA GRATIS\n';
//     text += ' JIKA TIDAK MENERIMA STRUK\n';
//     text += '\n  www.koperasi-stanley.com\n';
    
//     // Kurangi spacing (QR akan ditambahkan oleh print function)
//     text += '\n';
    
//     return text;
// }

// // ============================================
// // ROUTES
// // ============================================
// app.post('/print', async (req, res) => {
//     const start = Date.now();
    
//     try {
//         const { receipt, qr_image } = req.body;
        
//         // Generate text
//         const text = generateReceiptText(receipt);
        
//         // Backup text
//         const backupFile = path.join(BACKUP_DIR, `receipt-${receipt.invoice}.txt`);
//         fs.writeFile(backupFile, text, 'utf8', () => {});
        
//         // Backup QR jika QRIS
//         if (receipt.payment.toUpperCase() === 'QRIS' && qr_image) {
//             const qrBackupFile = path.join(BACKUP_DIR, `qr-${receipt.invoice}.png`);
//             const buffer = Buffer.from(qr_image, 'base64');
//             fs.writeFile(qrBackupFile, buffer, () => {});
//         }
        
//         // RESPONSE CEPAT ke client
//         res.json({ 
//             success: true, 
//             message: 'Receipt queued',
//             invoice: receipt.invoice,
//             elapsed: (Date.now() - start) + 'ms'
//         });
        
//         // QUEUE PRINT (mengantri)
//         queuePrint({
//             text,
//             qrImageBase64: (receipt.payment.toUpperCase() === 'QRIS') ? qr_image : null,
//             invoice: receipt.invoice
//         })
//         .then(() => {
//             console.log(`✅ Printed: ${receipt.invoice} (${Date.now() - start}ms)`);
//         })
//         .catch(err => {
//             console.error(`❌ ${receipt.invoice}: ${err.message}`);
//         });
        
//     } catch (error) {
//         res.status(500).json({ success: false, message: error.message });
//     }
// });

// app.post('/reprint', async (req, res) => {
//     try {
//         const { receipt, qr_image } = req.body;
//         const text = generateReceiptText(receipt);
        
//         // Reprint tanpa queue (langsung)
//         const result = await executePrint({
//             text,
//             qrImageBase64: (receipt.payment.toUpperCase() === 'QRIS') ? qr_image : null,
//             invoice: receipt.invoice
//         });
        
//         res.json({ success: true, message: 'Reprint success' });
//     } catch (error) {
//         res.status(500).json({ success: false, message: error.message });
//     }
// });

// app.get('/status', (req, res) => {
//     res.json({
//         printer: { 
//             ready: printerReady, 
//             name: currentPrinter,
//             printing: isPrinting,
//             queue: printQueue.length
//         },
//         uptime: process.uptime()
//     });
// });

// app.get('/test', async (req, res) => {
//     const testData = {
//         invoice: 'TEST-' + Date.now(),
//         date: new Date().toLocaleString('id-ID'),
//         cashier: 'Admin',
//         payment: 'CASH',
//         subtotal: 15000,
//         discount: 0,
//         total: 15000,
//         pay: 20000,
//         change: 5000,
//         charge: 0,
//         items: [{ name: 'Coca Cola', qty: 2, price: 5000, subtotal: 10000 }],
//         member: null
//     };
    
//     const text = generateReceiptText(testData);
    
//     try {
//         await executePrint({
//             text,
//             qrImageBase64: null,
//             invoice: testData.invoice
//         });
//         console.log('Test print OK');
//     } catch(e) {
//         console.error('Test print failed:', e.message);
//     }
    
//     res.json({ 
//         success: true, 
//         printer: currentPrinter,
//         ready: printerReady
//     });
// });

// app.get('/health', (req, res) => {
//     res.json({ 
//         status: printerReady ? 'ok' : 'no_printer',
//         printer: currentPrinter,
//         printing: isPrinting,
//         queue: printQueue.length
//     });
// });

// // ============================================
// // STARTUP
// // ============================================
// async function startServer() {
//     console.log('Initializing printer...');
//     await initPowerShell();
    
//     app.listen(3000, '0.0.0.0', () => {
//         console.log('========================================');
//         console.log(`  Printer: ${currentPrinter}`);
//         console.log(`  Status: ${printerReady ? 'READY' : 'ERROR'}`);
//         console.log('  Mode: Queue (no conflict)');
//         console.log('  http://localhost:3000');
//         console.log('========================================');
//     });
// }

// startServer();

// process.on('SIGINT', () => {
//     if (psProcess) psProcess.kill();
//     process.exit();
// });

// server.js - Fixed: Anti-stuck printer dengan retry & recovery
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

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// ============================================
// LOCK MECHANISM
// ============================================
let isPrinting = false;
let printQueue = [];
let currentPrinter = PRINTER_NAME;
let printerReady = false;
let psProcess = null;
let psRestartCount = 0;
let lastPrintTime = 0;
const MIN_PRINT_INTERVAL = 500; // Minimal jeda 500ms antar print

// ============================================
// RESET PRINTER (Clear stuck jobs)
// ============================================
function resetPrinter() {
    return new Promise((resolve) => {
        console.log('🔄 Resetting printer...');
        
        try {
            // Stop all print jobs
            execSync('Get-PrintJob -PrinterName "' + PRINTER_NAME + '" | Remove-PrintJob -ErrorAction SilentlyContinue', {
                shell: 'powershell',
                timeout: 5000
            });
            console.log('  ✓ Print jobs cleared');
        } catch(e) {
            console.log('  ⚠ No jobs to clear');
        }
        
        // Restart spooler jika perlu
        if (RESET_PRINTER_ON_STUCK) {
            try {
                execSync('Restart-Service -Name Spooler -Force', {
                    shell: 'powershell',
                    timeout: 10000
                });
                console.log('  ✓ Print spooler restarted');
            } catch(e) {
                console.log('  ⚠ Cannot restart spooler (admin required)');
            }
        }
        
        // Tunggu spooler siap
        setTimeout(() => {
            console.log('  ✓ Printer reset complete');
            resolve(true);
        }, 2000);
    });
}

// ============================================
// CLEAR PRINTER (via PowerShell)
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
    } catch(e) {
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
        } catch(e) {}
        psProcess = null;
    }
}

function initPowerShell() {
    return new Promise((resolve) => {
        killPowerShell();
        
        // Clear printer before init
        clearPrinterJobs();
        
        // Small delay
        setTimeout(() => {
            psProcess = spawn('powershell', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            let buffer = '';
            let resolved = false;
            
            const initCommands = `
                Add-Type -AssemblyName System.Drawing
                $printer = "${PRINTER_NAME}"
                
                # Test printer
                $doc = New-Object System.Drawing.Printing.PrintDocument
                $doc.PrinterSettings.PrinterName = $printer
                
                if ($doc.PrinterSettings.IsValid) {
                    Write-Output "PRINTER_READY:$printer"
                } else {
                    Write-Output "PRINTER_ERROR:$printer"
                }
                $doc.Dispose()
            `;

            // Error handler untuk stderr
            const stderrHandler = (data) => {
                const msg = data.toString();
                // Jangan log error "Exception calling Print" karena itu dari PrintDocument
                if (!msg.includes('Exception calling "Print"') && 
                    !msg.includes('PrintDocument') &&
                    !msg.includes('at System.Drawing')) {
                    console.error('PS Stderr:', msg);
                }
            };
            
            psProcess.stderr.on('data', stderrHandler);

            // Data handler
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

            // Process close handler
            psProcess.on('close', (code) => {
                printerReady = false;
                psProcess = null;
                
                if (!resolved) {
                    resolved = true;
                    resolve(false);
                }
                
                console.log(`⚠ PowerShell closed (code: ${code})`);
                
                // Auto restart dengan backoff
                const delay = Math.min(psRestartCount * 2000, 10000);
                psRestartCount++;
                console.log(`  Restarting in ${delay/1000}s...`);
                
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

            // Timeout
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    console.error('⏱ PS init timeout');
                    psProcess.stdout.removeListener('data', dataHandler);
                    killPowerShell();
                    resolve(false);
                }
            }, 15000);
            
        }, 1000); // Delay 1 detik sebelum init
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
    
    // Tunggu sebelum reinit
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
// PRINT QUEUE PROCESSOR
// ============================================
async function processPrintQueue() {
    if (isPrinting || printQueue.length === 0) return;
    
    // Jeda minimal antar print
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
        job.resolve(result);
    } catch (error) {
        console.error(`❌ Job failed: ${error.message}`);
        // Jangan reject, coba recovery dan retry queue
        if (error.message.includes('stuck') || error.message.includes('timeout')) {
            console.log('🔄 Recovering printer...');
            await recoverPrinter();
            
            // Re-queue job
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
            
            // Reset kecil antar retry
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
// EXECUTE PRINT
// ============================================
function executePrint(job) {
    return new Promise((resolve, reject) => {
        if (!printerReady || !psProcess || psProcess.killed) {
            // Coba restart PowerShell
            console.log('⚠ Printer not ready, restarting PS...');
            return reject(new Error('Printer not ready - restarting'));
        }

        const { text, qrImageBase64, invoice } = job;
        const printId = `P_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
        // Buat temp files
        const txtFile = path.join(TEMP_DIR, `txt-${printId}.txt`);
        const qrFile = qrImageBase64 ? path.join(TEMP_DIR, `qr-${printId}.png`) : null;
        
        try {
            fs.writeFileSync(txtFile, text, 'utf8');
            if (qrFile) {
                fs.writeFileSync(qrFile, Buffer.from(qrImageBase64, 'base64'));
            }
        } catch(e) {
            return reject(new Error(`File error: ${e.message}`));
        }
        
        const txtPath = txtFile.replace(/\\/g, '\\\\');
        const qrPath = qrFile ? qrFile.replace(/\\/g, '\\\\') : '';
        
        let command = '';
        
        if (qrImageBase64) {
            command = `
                $ErrorActionPreference = "Stop"
                try {
                    Add-Type -AssemblyName System.Drawing
                    
                    $txt = Get-Content "${txtPath}" -Raw -ErrorAction Stop
                    $f = New-Object System.Drawing.Font("Courier New", 8)
                    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
                    $qr = [System.Drawing.Image]::FromFile("${qrPath}")
                    $paperWidth = 220
                    $qrSize = 160
                    $qrX = [Math]::Floor(($paperWidth - $qrSize) / 2)
                    
                    $measureBmp = New-Object System.Drawing.Bitmap(1, 1)
                    $measureGfx = [System.Drawing.Graphics]::FromImage($measureBmp)
                    $measureFont = New-Object System.Drawing.Font("Courier New", 8)
                    $measureRect = New-Object System.Drawing.RectangleF(0, 0, 210, 2000)
                    $textSize = $measureGfx.MeasureString($txt, $measureFont, $measureRect.Size)
                    $textHeight = [Math]::Ceiling($textSize.Height) + 10
                    $measureGfx.Dispose()
                    $measureBmp.Dispose()
                    $measureFont.Dispose()
                    
                    $qrY = $textHeight + 20
                    
                    $d = New-Object System.Drawing.Printing.PrintDocument
                    $d.PrinterSettings.PrinterName = "${currentPrinter}"
                    $d.DocumentName = "Receipt-QRIS"
                    
                    $d.Add_PrintPage({
                        $textRect = New-Object System.Drawing.RectangleF(5, 5, 220, 800)
                        $_.Graphics.DrawString($txt, $f, $b, $textRect)
                        $qrRect = New-Object System.Drawing.Rectangle($qrX, $qrY, $qrSize, $qrSize)
                        $_.Graphics.DrawImage($qr, $qrRect)
                        $_.HasMorePages = $false
                    })
                    
                    $d.Print()
                    $d.Dispose()
                    $f.Dispose()
                    $b.Dispose()
                    $qr.Dispose()
                    
                    Remove-Item "${txtPath}" -Force -ErrorAction SilentlyContinue
                    Remove-Item "${qrPath}" -Force -ErrorAction SilentlyContinue
                    
                    Write-Output "${printId}:OK"
                } catch {
                    $errMsg = $_.Exception.Message
                    if ($d) { try { $d.Dispose() } catch {} }
                    if ($f) { try { $f.Dispose() } catch {} }
                    if ($b) { try { $b.Dispose() } catch {} }
                    if ($qr) { try { $qr.Dispose() } catch {} }
                    Write-Output "${printId}:ERR:$errMsg"
                }
            `;
        } else {
            command = `
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
        }
        
        // Timeout handler
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error(`Print timeout (${PRINT_TIMEOUT/1000}s) - printer may be stuck`));
            }, PRINT_TIMEOUT);
        });
        
        // Response handler
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
                    
                    // Cek error spesifik
                    if (errorMsg.includes('timed out') || errorMsg.includes('not ready')) {
                        reject(new Error(`Printer stuck: ${errorMsg}`));
                    } else {
                        reject(new Error(errorMsg));
                    }
                }
            };
            
            psProcess.stdout.on('data', handler);
        });
        
        // Write command
        try {
            psProcess.stdin.write(command + '\n');
        } catch(e) {
            clearTimeout(timeoutId);
            cleanup();
            return reject(new Error(`Cannot write to PS: ${e.message}`));
        }
        
        // Race: response vs timeout
        Promise.race([responsePromise, timeoutPromise])
            .then(resolve)
            .catch(reject);
        
        function cleanup() {
            setTimeout(() => {
                try { if (fs.existsSync(txtFile)) fs.unlinkSync(txtFile); } catch(e) {}
                if (qrFile) {
                    try { if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile); } catch(e) {}
                }
            }, 1000);
        }
    });
}

// ============================================
// GENERATE RECEIPT TEXT
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
        
        // Backup
        const backupFile = path.join(BACKUP_DIR, `receipt-${receipt.invoice}.txt`);
        fs.writeFile(backupFile, text, 'utf8', () => {});
        
        if (receipt.payment.toUpperCase() === 'QRIS' && qr_image) {
            const qrBackupFile = path.join(BACKUP_DIR, `qr-${receipt.invoice}.png`);
            fs.writeFile(qrBackupFile, Buffer.from(qr_image, 'base64'), () => {});
        }
        
        // Fast response
        res.json({ 
            success: true, 
            message: 'Receipt queued',
            invoice: receipt.invoice,
            queue: printQueue.length,
            elapsed: (Date.now() - start) + 'ms'
        });
        
        // Queue print
        queuePrint({
            text,
            qrImageBase64: (receipt.payment.toUpperCase() === 'QRIS') ? qr_image : null,
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
        const { receipt, qr_image } = req.body;
        const text = generateReceiptText(receipt);
        
        // Clear jobs dulu sebelum reprint
        clearPrinterJobs();
        await new Promise(r => setTimeout(r, 1000));
        
        const result = await executePrint({
            text,
            qrImageBase64: (receipt.payment.toUpperCase() === 'QRIS') ? qr_image : null,
            invoice: receipt.invoice + '-REPRINT'
        });
        
        res.json({ success: true, message: 'Reprint success' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Manual reset endpoint
app.post('/reset-printer', async (req, res) => {
    console.log('🔧 Manual printer reset requested');
    await recoverPrinter();
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
            lastPrint: lastPrintTime ? new Date(lastPrintTime).toISOString() : null
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
        await executePrint({ text, qrImageBase64: null, invoice: testData.invoice });
        console.log('✅ Test print OK');
        res.json({ success: true, printer: currentPrinter, ready: printerReady });
    } catch(e) {
        console.error('❌ Test failed:', e.message);
        
        // Auto recovery
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
        psAlive: psProcess && !psProcess.killed
    });
});

// ============================================
// MONITORING - Auto restart jika printer stuck
// ============================================
let lastSuccessfulPrint = Date.now();

setInterval(async () => {
    const idleTime = Date.now() - lastSuccessfulPrint;
    
    // Jika ada di queue tapi tidak ada yang print > 60 detik
    if (printQueue.length > 0 && !isPrinting && idleTime > 60000) {
        console.log('⚠ Queue stuck detected, recovering...');
        await recoverPrinter();
        lastSuccessfulPrint = Date.now();
        processPrintQueue();
    }
    
    // Health check setiap 5 menit
    if (idleTime > 300000 && printerReady) {
        console.log('🔍 Health check - testing printer...');
        const testData = {
            invoice: 'HC-' + Date.now(),
            date: new Date().toLocaleString('id-ID'),
            cashier: 'System',
            payment: 'CASH',
            subtotal: 0, discount: 0, total: 0, pay: 0, change: 0, charge: 0,
            items: [{ name: 'Health Check', qty: 1, price: 0, subtotal: 0 }],
            member: null
        };
        
        try {
            await executePrint({ 
                text: 'Health Check\n' + new Date().toISOString() + '\n\n\n', 
                qrImageBase64: null, 
                invoice: testData.invoice 
            });
            lastSuccessfulPrint = Date.now();
            console.log('✅ Health check OK');
        } catch(e) {
            console.log('⚠ Health check failed, recovering...');
            await recoverPrinter();
        }
    }
}, 60000); // Check setiap menit

// ============================================
// STARTUP
// ============================================
async function startServer() {
    console.log('========================================');
    console.log('  Koperasi Stanley - Print Server');
    console.log('  Mode: Anti-Stuck with Auto Recovery');
    console.log('========================================');
    
    console.log('Initializing printer...');
    await initPowerShell();
    
    app.listen(3000, '0.0.0.0', () => {
        console.log('========================================');
        console.log(`  Printer : ${currentPrinter}`);
        console.log(`  Status  : ${printerReady ? '✅ READY' : '❌ ERROR'}`);
        console.log(`  Retry   : ${MAX_RETRY}x`);
        console.log(`  Timeout : ${PRINT_TIMEOUT/1000}s`);
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

// Uncaught errors
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled rejection:', reason);
});