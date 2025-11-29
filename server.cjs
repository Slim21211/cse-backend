const express = require('express');
const cors = require('cors'); 
const https = require('https'); 
const fs = require('fs');       
const path = require('path');   
const {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand
} = require('@aws-sdk/client-s3');
require('dotenv/config');

const app = express();
// Порт 443 — стандартный порт для HTTPS
const PORT = 443; 
// 💡 КОНФИГУРАЦИЯ СЕРТИФИКАТОВ - ОБНОВЛЕНО 
const DOMAIN_NAME = 'api.cse-contests.ru';
const PUBLIC_IP = '5.35.13.171';
const CERT_PATH = `/etc/letsencrypt/live/${DOMAIN_NAME}/`;

// --- Конфигурация Middleware ---
// Увеличен лимит тела запроса и таймаут S3 в клиенте
app.use(cors()); 
app.use(express.json({ limit: '100mb' })); 
app.use(express.raw({ limit: '100mb', type: 'application/octet-stream' })); 

// --- Конфигурация S3 ---
// Установим таймаут S3 клиента на 5 минут
const s3 = new S3Client({
    region: 'ru-msk', 
    endpoint: process.env.S3_ENDPOINT, 
    maxAttempts: 5, // Увеличим попытки
    requestHandler: {
        socketTimeout: 300000, // Таймаут сокета S3
        connectionTimeout: 300000, // Таймаут соединения S3
    },
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
    },
});

// ==========================================================
// 1. РОУТ: /upload-start (Начало загрузки)
// ==========================================================
app.post('/upload-start', async (req, res) => {
    try {
        const { filename, contentType } = req.body;

        // 🛡️ Проверка на 0 байт
        if (req.body.fileSize === 0) {
             return res.status(400).json({ error: 'File size must be greater than 0 bytes' });
        }


        if (!filename || !contentType) {
            return res.status(400).json({ error: 'Missing params' });
        }

        const command = new CreateMultipartUploadCommand({
            Bucket: 'cse-contests',
            Key: filename, 
            ContentType: contentType,
            ACL: 'public-read',
        });

        const response = await s3.send(command);

        return res.status(200).json({
            uploadId: response.UploadId,
            key: filename,
        });
    } catch (err) {
        console.error('Start multipart error:', err);
        return res.status(500).json({
            error: 'Ошибка начала загрузки',
            details: err instanceof Error ? err.message : 'Unknown error',
        });
    }
});

// ==========================================================
// 2. РОУТ: /upload-part (Загрузка части)
// ==========================================================
app.post('/upload-part', async (req, res) => {
    try {
        const { filename, uploadId, partNumber } = req.query;
        const body = req.body; 

        if (!filename || !uploadId || !partNumber) {
            return res.status(400).json({ error: 'Missing params', details: 'Check filename, uploadId, or partNumber in query.' });
        }
        if (!(body instanceof Buffer)) {
            return res.status(400).json({ error: 'Body must be raw buffer' });
        }
        
        const result = await s3.send(
            new UploadPartCommand({
                Bucket: 'cse-contests',
                Key: decodeURIComponent(filename),
                UploadId: uploadId,
                PartNumber: Number(partNumber),
                Body: body, 
            })
        );

        return res.status(200).json({ etag: result.ETag?.replace(/"/g, '') });

    } catch (e) {
        console.error('Upload part error:', e); 
        const details = e.message || 'Unknown error';
        return res.status(500).json({ error: 'Upload failed', details: details });
    }
});

// ==========================================================
// 3. РОУТ: /upload-complete (Завершение)
// ==========================================================
app.post('/upload-complete', async (req, res) => {
    try {
        const { filename, uploadId, parts } = req.body;

        if (!filename || !uploadId || !parts) {
            return res.status(400).json({ error: 'Missing params' });
        }

        const sortedParts = parts
            .sort((a, b) => Number(a.PartNumber) - Number(b.PartNumber)) 
            .map((p) => ({
                PartNumber: Number(p.PartNumber), 
                ETag: String(p.ETag).replace(/"/g, ''), 
            }));

        await s3.send(
            new CompleteMultipartUploadCommand({
                Bucket: 'cse-contests',
                Key: decodeURIComponent(filename), 
                UploadId: uploadId,
                MultipartUpload: { Parts: sortedParts },
            })
        );

        const publicUrl = `https://cse-contests.hb.ru-msk.vkcloud-storage.ru/${filename}`;
        return res.status(200).json({
            publicUrl,
        });
    } catch (err) {
        console.error('CRITICAL S3 COMPLETE ERROR:', err);
        const details = err.message || 'Неизвестная ошибка сервера.';
        return res.status(500).json({ 
            error: 'Не удалось завершить загрузку на стороне S3.', 
            details: details
        });
    }
});

// ==========================================================
// --- Запуск сервера с HTTPS ---
// ==========================================================
try {
    const options = {
        key: fs.readFileSync(path.join(CERT_PATH, 'privkey.pem')),
        cert: fs.readFileSync(path.join(CERT_PATH, 'fullchain.pem')),
    };

    const httpsServer = https.createServer(options, app);

    const server = httpsServer.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running securely on HTTPS at port ${PORT}`);
        console.log(`Access is via ${DOMAIN_NAME}`);
    });

    // Увеличенный таймаут HTTP-соединения (5 минут)
    server.timeout = 300000; 
} catch (e) {
    console.error(`\n--- CRITICAL ERROR: HTTPS SETUP FAILED ---`);
    console.error(`НЕ УДАЛОСЬ ЗАПУСТИТЬ СЕРВЕР С HTTPS! Вероятно, отсутствуют сертификаты.`);
    console.error(`Ошибка: ${e.message}`);
    console.error(`\n--- FALLBACK: HTTP SERVER STARTED ---`);
    console.warn(`ВРЕМЕННО ЗАПУЩЕН HTTP на порту 80 (для Certbot).`);
    
    // В случае ошибки HTTPS, запускаем обычный HTTP-сервер на порту 80 (для работы Certbot)
    const httpFallbackServer = app.listen(80, '0.0.0.0', () => {
        console.warn(`HTTP сервер запущен на порту 80.`);
    });
    httpFallbackServer.timeout = 300000;
}
