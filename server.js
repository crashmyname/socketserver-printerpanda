// server.js - Fixed: Print conflict issue
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// KONFIGURASI
// ============================================
const TEMP_DIR = path.join(__dirname, 'temp');
const BACKUP_DIR = path.join(__dirname, 'backup');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// ============================================
// LOCK MECHANISM (untuk mencegah print bersamaan)
// ============================================
let isPrinting = false;
let printQueue = [];
let currentPrinter = 'POS58';
let printerReady = false;

// ============================================
// POWERSHELL SESSION - SATU INSTANCE SAJA
// ============================================
let psProcess = null;

function initPowerShell() {
    return new Promise((resolve) => {
        if (psProcess) {
            try { psProcess.kill(); } catch(e) {}
        }
        
        psProcess = spawn('powershell', ['-NoLogo', '-NoProfile', '-Command', '-'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const initCommands = `
            Add-Type -AssemblyName System.Drawing
            $printer = "POS58"
            
            # Validasi printer
            $doc = New-Object System.Drawing.Printing.PrintDocument
            $doc.PrinterSettings.PrinterName = $printer
            
            if ($doc.PrinterSettings.IsValid) {
                Write-Output "PRINTER_READY:POS58"
            } else {
                Write-Output "PRINTER_ERROR"
            }
            $doc.Dispose()
        `;

        psProcess.stdin.write(initCommands + '\n');

        let buffer = '';
        const onData = (data) => {
            buffer += data.toString();
            if (buffer.includes('PRINTER_READY:')) {
                currentPrinter = buffer.split('PRINTER_READY:')[1].trim();
                printerReady = true;
                console.log(`✓ Printer ready: ${currentPrinter}`);
                psProcess.stdout.removeListener('data', onData);
                resolve(true);
            }
            if (buffer.includes('PRINTER_ERROR')) {
                console.error('✗ Printer not found');
                printerReady = false;
                psProcess.stdout.removeListener('data', onData);
                resolve(false);
            }
        };

        psProcess.stdout.on('data', onData);

        psProcess.stderr.on('data', (d) => {
            // Hanya log error yang bukan dari print (error print ditangani sendiri)
            if (!d.toString().includes('Exception calling "Print"')) {
                console.error('PS:', d.toString());
            }
        });
        
        psProcess.on('close', (code) => {
            printerReady = false;
            console.log(`PowerShell closed (code: ${code}), restarting in 3s...`);
            setTimeout(() => initPowerShell(), 3000);
        });

        // Timeout 10 detik
        setTimeout(() => {
            if (!printerReady) {
                console.log('PowerShell init timeout');
                resolve(false);
            }
        }, 10000);
    });
}

// ============================================
// PRINT QUEUE PROCESSOR
// ============================================
async function processPrintQueue() {
    if (isPrinting || printQueue.length === 0) return;
    
    isPrinting = true;
    const job = printQueue.shift();
    
    try {
        const result = await executePrint(job);
        job.resolve(result);
    } catch (error) {
        job.reject(error);
    } finally {
        isPrinting = false;
        // Process next job if any
        if (printQueue.length > 0) {
            setTimeout(() => processPrintQueue(), 100); // Delay kecil antar print
        }
    }
}

function queuePrint(job) {
    return new Promise((resolve, reject) => {
        printQueue.push({ ...job, resolve, reject });
        processPrintQueue();
    });
}

// ============================================
// EXECUTE PRINT - QR CENTERED & SMALLER
// ============================================
function executePrint(job) {
    return new Promise((resolve, reject) => {
        if (!printerReady || !psProcess || psProcess.killed) {
            return reject(new Error('Printer not ready'));
        }

        const { text, qrImageBase64, invoice } = job;
        const printId = `PRINT_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
        // Buat file temporary
        const txtFile = path.join(TEMP_DIR, `r-${printId}.txt`);
        fs.writeFileSync(txtFile, text, 'utf8');
        
        let command = '';
        
        if (qrImageBase64) {
            // Print dengan QR code
            const qrFile = path.join(TEMP_DIR, `qr-${printId}.png`);
            const buffer = Buffer.from(qrImageBase64, 'base64');
            fs.writeFileSync(qrFile, buffer);
            
            const txtPath = txtFile.replace(/\\/g, '\\\\');
            const qrPath = qrFile.replace(/\\/g, '\\\\');
            
            command = `
                try {
                    # Load resources
                    $txt = Get-Content "${txtPath}" -Raw
                    $f = New-Object System.Drawing.Font("Courier New", 8)
                    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
                    $qr = [System.Drawing.Image]::FromFile("${qrPath}")
                    
                    # Paper size (58mm = 220px)
                    $paperWidth = 220
                    
                    # QR SIZE - LEBIH KECIL
                    $qrSize = 160
                    
                    # HITUNG POSISI X SUPAYA CENTER
                    $qrX = [Math]::Floor(($paperWidth - $qrSize) / 2)
                    
                    # HITUNG TINGGI TEXT
                    $measureBmp = New-Object System.Drawing.Bitmap(1, 1)
                    $measureGfx = [System.Drawing.Graphics]::FromImage($measureBmp)
                    $measureFont = New-Object System.Drawing.Font("Courier New", 8)
                    $measureRect = New-Object System.Drawing.RectangleF(0, 0, 210, 2000)
                    $textSize = $measureGfx.MeasureString($txt, $measureFont, $measureRect.Size)
                    $textHeight = [Math]::Ceiling($textSize.Height) + 10
                    $measureGfx.Dispose()
                    $measureBmp.Dispose()
                    $measureFont.Dispose()
                    
                    # Posisi Y setelah text + padding
                    $qrY = $textHeight + 20
                    
                    # Create document
                    $d = New-Object System.Drawing.Printing.PrintDocument
                    $d.PrinterSettings.PrinterName = "${currentPrinter}"
                    $d.DocumentName = "Receipt-QRIS"
                    
                    $d.Add_PrintPage({
                        # Draw text - SAMA PERSIS DENGAN NON-QRIS
                        $textRect = New-Object System.Drawing.RectangleF(5, 5, 220, 800)
                        $_.Graphics.DrawString($txt, $f, $b, $textRect)
                        
                        # Draw QR code CENTER
                        $qrRect = New-Object System.Drawing.Rectangle($qrX, $qrY, $qrSize, $qrSize)
                        $_.Graphics.DrawImage($qr, $qrRect)
                        
                        $_.HasMorePages = $false
                    })
                    
                    $d.Print()
                    
                    # Cleanup
                    $d.Dispose()
                    $f.Dispose()
                    $b.Dispose()
                    $qr.Dispose()
                    
                    # Remove temp files
                    Remove-Item "${txtPath}" -Force -ErrorAction SilentlyContinue
                    Remove-Item "${qrPath}" -Force -ErrorAction SilentlyContinue
                    
                    Write-Output "${printId}:SUCCESS"
                } catch {
                    Write-Output "${printId}:ERROR:$($_.Exception.Message)"
                    if ($d) { $d.Dispose() }
                    if ($f) { $f.Dispose() }
                    if ($b) { $b.Dispose() }
                    if ($qr) { $qr.Dispose() }
                }
            `;
            
        } else {
            // Print text saja
            const txtPath = txtFile.replace(/\\/g, '\\\\');
            
            command = `
                try {
                    $txt = Get-Content "${txtPath}" -Raw
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
                    
                    # Cleanup
                    $d.Dispose()
                    $f.Dispose()
                    $b.Dispose()
                    
                    Remove-Item "${txtPath}" -Force -ErrorAction SilentlyContinue
                    
                    Write-Output "${printId}:SUCCESS"
                } catch {
                    Write-Output "${printId}:ERROR:$($_.Exception.Message)"
                    if ($d) { $d.Dispose() }
                    if ($f) { $f.Dispose() }
                    if ($b) { $b.Dispose() }
                }
            `;
        }
        
        // Set timeout
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Print timeout'));
        }, 15000);
        
        // Listener untuk response
        const onData = (data) => {
            const response = data.toString();
            
            if (response.includes(`${printId}:SUCCESS`)) {
                clearTimeout(timeout);
                psProcess.stdout.removeListener('data', onData);
                cleanup();
                resolve({ success: true, printId });
            }
            
            if (response.includes(`${printId}:ERROR:`)) {
                const errorMsg = response.split(`${printId}:ERROR:`)[1].trim();
                clearTimeout(timeout);
                psProcess.stdout.removeListener('data', onData);
                cleanup();
                reject(new Error(errorMsg));
            }
        };
        
        psProcess.stdout.on('data', onData);
        psProcess.stdin.write(command + '\n');
        
        function cleanup() {
            setTimeout(() => {
                try { fs.unlinkSync(txtFile); } catch(e) {}
                if (qrImageBase64) {
                    const qrFile = path.join(TEMP_DIR, `qr-${printId}.png`);
                    try { fs.unlinkSync(qrFile); } catch(e) {}
                }
            }, 500);
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
    
    // Kurangi spacing (QR akan ditambahkan oleh print function)
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
        
        // Generate text
        const text = generateReceiptText(receipt);
        
        // Backup text
        const backupFile = path.join(BACKUP_DIR, `receipt-${receipt.invoice}.txt`);
        fs.writeFile(backupFile, text, 'utf8', () => {});
        
        // Backup QR jika QRIS
        if (receipt.payment.toUpperCase() === 'QRIS' && qr_image) {
            const qrBackupFile = path.join(BACKUP_DIR, `qr-${receipt.invoice}.png`);
            const buffer = Buffer.from(qr_image, 'base64');
            fs.writeFile(qrBackupFile, buffer, () => {});
        }
        
        // RESPONSE CEPAT ke client
        res.json({ 
            success: true, 
            message: 'Receipt queued',
            invoice: receipt.invoice,
            elapsed: (Date.now() - start) + 'ms'
        });
        
        // QUEUE PRINT (mengantri)
        queuePrint({
            text,
            qrImageBase64: (receipt.payment.toUpperCase() === 'QRIS') ? qr_image : null,
            invoice: receipt.invoice
        })
        .then(() => {
            console.log(`✅ Printed: ${receipt.invoice} (${Date.now() - start}ms)`);
        })
        .catch(err => {
            console.error(`❌ ${receipt.invoice}: ${err.message}`);
        });
        
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/reprint', async (req, res) => {
    try {
        const { receipt, qr_image } = req.body;
        const text = generateReceiptText(receipt);
        
        // Reprint tanpa queue (langsung)
        const result = await executePrint({
            text,
            qrImageBase64: (receipt.payment.toUpperCase() === 'QRIS') ? qr_image : null,
            invoice: receipt.invoice
        });
        
        res.json({ success: true, message: 'Reprint success' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/status', (req, res) => {
    res.json({
        printer: { 
            ready: printerReady, 
            name: currentPrinter,
            printing: isPrinting,
            queue: printQueue.length
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
        await executePrint({
            text,
            qrImageBase64: null,
            invoice: testData.invoice
        });
        console.log('Test print OK');
    } catch(e) {
        console.error('Test print failed:', e.message);
    }
    
    res.json({ 
        success: true, 
        printer: currentPrinter,
        ready: printerReady
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: printerReady ? 'ok' : 'no_printer',
        printer: currentPrinter,
        printing: isPrinting,
        queue: printQueue.length
    });
});

// ============================================
// STARTUP
// ============================================
async function startServer() {
    console.log('Initializing printer...');
    await initPowerShell();
    
    app.listen(3000, '0.0.0.0', () => {
        console.log('========================================');
        console.log(`  Printer: ${currentPrinter}`);
        console.log(`  Status: ${printerReady ? 'READY' : 'ERROR'}`);
        console.log('  Mode: Queue (no conflict)');
        console.log('  http://localhost:3000');
        console.log('========================================');
    });
}

startServer();

process.on('SIGINT', () => {
    if (psProcess) psProcess.kill();
    process.exit();
});