// server.js - Hybrid: PowerShell session + Fast response
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const app = express();

app.use(cors());
// Naikkan limit untuk base64 image
app.use(express.json({ limit: '10mb' }));

// ============================================
// KONFIGURASI
// ============================================
const TEMP_DIR = path.join(__dirname, 'temp');
const BACKUP_DIR = path.join(__dirname, 'backup');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// ============================================
// POWERSHELL SESSION (Init sekali)
// ============================================
let psProcess = null;
let printerReady = false;
let currentPrinter = 'POS58';

function initPowerShell() {
    return new Promise((resolve) => {
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
        `;

        psProcess.stdin.write(initCommands + '\n');

        let buffer = '';
        psProcess.stdout.on('data', (data) => {
            buffer += data.toString();
            if (buffer.includes('PRINTER_READY:')) {
                currentPrinter = buffer.split('PRINTER_READY:')[1].trim();
                printerReady = true;
                console.log(`✓ Printer ready: ${currentPrinter}`);
                resolve(true);
            }
            if (buffer.includes('PRINTER_ERROR')) {
                console.error('✗ Printer not found');
                printerReady = false;
                resolve(false);
            }
        });

        psProcess.stderr.on('data', (d) => console.error('PS:', d.toString()));
        
        psProcess.on('close', () => {
            printerReady = false;
            console.log('PowerShell closed, restarting in 3s...');
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
// PRINT FUNCTION - DUA VERSI
// ============================================

// Versi 1: Print text saja (untuk CASH/CREDIT)
function printReceiptText(text) {
    return new Promise((resolve, reject) => {
        if (!printerReady || !psProcess || psProcess.killed) {
            return reject(new Error('Printer not ready'));
        }

        const txtFile = path.join(TEMP_DIR, `r-${Date.now()}.txt`);
        fs.writeFileSync(txtFile, text, 'utf8');

        const command = `
            $txt = Get-Content "${txtFile.replace(/\\/g, '\\\\')}" -Raw
            $f = New-Object System.Drawing.Font("Courier New", 8)
            $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
            $d = New-Object System.Drawing.Printing.PrintDocument
            $d.PrinterSettings.PrinterName = "${currentPrinter}"
            $d.DocumentName = "Receipt"
            $d.Add_PrintPage({
                $r = New-Object System.Drawing.RectangleF(5,5,220,800)
                $_.Graphics.DrawString($txt, $f, $b, $r)
                $_.HasMorePages = $false
            })
            $d.Print()
            $d.Dispose()
            $f.Dispose()
            $b.Dispose()
            Write-Output "OK:${txtFile}"
        `;

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Print timeout'));
        }, 5000);

        const onData = (data) => {
            if (data.toString().includes(`OK:${txtFile}`)) {
                clearTimeout(timeout);
                psProcess.stdout.removeListener('data', onData);
                cleanup();
                resolve({ success: true });
            }
        };

        psProcess.stdout.on('data', onData);
        psProcess.stdin.write(command + '\n');

        function cleanup() {
            setTimeout(() => {
                try { fs.unlinkSync(txtFile); } catch(e) {}
            }, 1000);
        }
    });
}

// Versi 2: Print text + QR Code (untuk QRIS)
// Versi 2: Print text + QR Code (untuk QRIS)
function printReceiptWithQR(text, qrImageBase64) {
    return new Promise((resolve, reject) => {
        if (!printerReady || !psProcess || psProcess.killed) {
            return reject(new Error('Printer not ready'));
        }

        const txtFile = path.join(TEMP_DIR, `r-${Date.now()}.txt`);
        const qrFile = path.join(TEMP_DIR, `qr-${Date.now()}.png`);
        
        fs.writeFileSync(txtFile, text, 'utf8');
        
        // Simpan QR code sebagai PNG
        const buffer = Buffer.from(qrImageBase64, 'base64');
        fs.writeFileSync(qrFile, buffer);

        const txtPath = txtFile.replace(/\\/g, '\\\\');
        const qrPath = qrFile.replace(/\\/g, '\\\\');

        const command = `
            # Load text
            $txt = Get-Content "${txtPath}" -Raw
            
            # Font
            $f = New-Object System.Drawing.Font("Courier New", 8)
            $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
            
            # Load QR image
            $qr = [System.Drawing.Image]::FromFile("${qrPath}")
            
            # UKURAN QR LEBIH KECIL
            $qrSize = 100      # Ukuran QR code (100x100 pixel)
            $qrX = 60          # Posisi X (center di kertas 58mm)
            $qrY = 340         # Posisi Y (lebih dekat ke text)
            
            $d = New-Object System.Drawing.Printing.PrintDocument
            $d.PrinterSettings.PrinterName = "${currentPrinter}"
            $d.DocumentName = "Receipt-QRIS"
            
            $d.Add_PrintPage({
                # Draw text di area atas
                $textRect = New-Object System.Drawing.RectangleF(5, 5, 220, 800)
                $_.Graphics.DrawString($txt, $f, $b, $textRect)
                
                # Draw QR code di bawah text
                $_.Graphics.DrawImage($qr, $qrX, $qrY, $qrSize, $qrSize)
                
                $_.HasMorePages = $false
            })
            
            $d.Print()
            $d.Dispose()
            $f.Dispose()
            $b.Dispose()
            $qr.Dispose()
            Write-Output "OK:${txtFile}"
        `;

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Print timeout'));
        }, 8000);

        const onData = (data) => {
            if (data.toString().includes(`OK:${txtFile}`)) {
                clearTimeout(timeout);
                psProcess.stdout.removeListener('data', onData);
                cleanup();
                resolve({ success: true });
            }
        };

        psProcess.stdout.on('data', onData);
        psProcess.stdin.write(command + '\n');

        function cleanup() {
            setTimeout(() => {
                try { 
                    fs.unlinkSync(txtFile); 
                    fs.unlinkSync(qrFile);
                } catch(e) {}
            }, 1000);
        }
    });
}

// ============================================
// GENERATE RECEIPT TEXT
// ============================================
function generateReceiptText(data) {
    let text = '';
    
    text += '     KOPERASI STANLEY\n';
    text += 'PT INDONESIA STANLEY ELECTRIC\n';
    text += '    Telp : 0822-6000-9636\n';
    text += '-------------------------------\n';
    
    text += `Invoice : ${data.invoice}\n`;
    text += `Date    : ${data.date}\n`;
    text += `Cashier : ${data.cashier || 'Admin'}\n`;
    text += `Payment : ${data.payment.toUpperCase()}\n`;
    text += '-------------------------------\n';
    
    data.items.forEach(item => {
        const price = item.price.toLocaleString('id-ID');
        const subtotal = item.subtotal.toLocaleString('id-ID');
        text += `${item.name}\n`;
        text += `${item.qty} x ${price}\t\t${subtotal}\n\n`;
    });
    
    text += '-------------------------------\n';
    
    const fmt = (num) => num.toLocaleString('id-ID');
    text += `Subtotal : ${fmt(data.subtotal)}\n`;
    if (data.discount > 0) text += `Discount : ${fmt(data.discount)}\n`;
    text += `TOTAL    : ${fmt(data.total)}\n`;
    text += `Bayar    : ${fmt(data.pay)}\n`;
    if (data.change > 0) text += `Kembali  : ${fmt(data.change)}\n`;
    
    text += '-------------------------------\n';
    
    if (data.member) {
        text += `Member   : ${data.member.name}\n`;
        text += `Cashback : ${fmt(data.member.cashback)}\n`;
        text += '-------------------------------\n';
    }
    
    text += '\n      TERIMA KASIH\n';
    text += '    BELANJA ANDA GRATIS\n';
    text += '  JIKA TIDAK MENERIMA STRUK\n';
    text += '\n  www.koperasi-stanley.com\n';
    text += '\n\n\n\n';
    
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
        
        // RESPONSE CEPAT
        res.json({ 
            success: true, 
            message: 'Receipt sent to printer',
            elapsed: (Date.now() - start) + 'ms'
        });
        
        // Pilih fungsi print sesuai payment method
        if (receipt.payment.toUpperCase() === 'QRIS' && qr_image) {
            // Print dengan QR code
            printReceiptWithQR(text, qr_image)
                .then(() => console.log(`✅ Printed QRIS: ${receipt.invoice} (${Date.now() - start}ms)`))
                .catch(err => console.error(`❌ ${receipt.invoice}: ${err.message}`));
        } else {
            // Print text saja
            printReceiptText(text)
                .then(() => console.log(`✅ Printed: ${receipt.invoice} (${Date.now() - start}ms)`))
                .catch(err => console.error(`❌ ${receipt.invoice}: ${err.message}`));
        }
        
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/reprint', async (req, res) => {
    try {
        const { receipt, qr_image } = req.body;
        const text = generateReceiptText(receipt);
        
        if (receipt.payment.toUpperCase() === 'QRIS' && qr_image) {
            await printReceiptWithQR(text, qr_image);
        } else {
            await printReceiptText(text);
        }
        
        res.json({ success: true, message: 'Reprint success' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/status', (req, res) => {
    res.json({
        printer: { ready: printerReady, name: currentPrinter },
        uptime: process.uptime()
    });
});

app.get('/test', (req, res) => {
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
    
    printReceiptText(text)
        .then(r => console.log('Test print OK'))
        .catch(e => console.error('Test print failed:', e.message));
    
    res.json({ 
        success: true, 
        printer: currentPrinter,
        ready: printerReady
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: printerReady ? 'ok' : 'no_printer',
        printer: currentPrinter
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
        console.log('  http://localhost:3000');
        console.log('========================================');
    });
}

startServer();

process.on('SIGINT', () => {
    if (psProcess) psProcess.kill();
    process.exit();
});