const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');
const urlModule = require('url');

const PORT = 3000;

// Setup binary path info
const getBinaryInfo = () => {
    let binaryName = 'yt-dlp.exe';
    let url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    if (process.platform === 'darwin') {
        binaryName = 'yt-dlp_macos';
        url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
    } else if (process.platform === 'linux') {
        binaryName = 'yt-dlp';
        url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    }
    return { name: binaryName, url, path: path.join(__dirname, 'bin', binaryName) };
};

// Make sure binary directory exists
const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir);
}

// Redirect-following HTTPS downloader
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        
        function get(currentUrl) {
            https.get(currentUrl, (response) => {
                if ([301, 302, 307, 308].includes(response.statusCode)) {
                    get(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download yt-dlp: Status ${response.statusCode}`));
                    return;
                }
                response.pipe(file);
                file.on('finish', () => {
                    file.close(resolve);
                });
            }).on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        }
        
        get(url);
    });
}

let downloadingPromise = null;
function ensureBinary() {
    const info = getBinaryInfo();
    if (fs.existsSync(info.path)) {
        return Promise.resolve(info.path);
    }
    if (downloadingPromise) {
        return downloadingPromise;
    }
    console.log(`Binary not found. Downloading yt-dlp from ${info.url}...`);
    downloadingPromise = downloadFile(info.url, info.path)
        .then(() => {
            console.log('yt-dlp downloaded successfully!');
            if (process.platform !== 'win32') {
                fs.chmodSync(info.path, 0o755);
            }
            downloadingPromise = null;
            return info.path;
        })
        .catch((err) => {
            console.error('Failed to download yt-dlp:', err);
            downloadingPromise = null;
            throw err;
        });
    return downloadingPromise;
}

// MIME type lookup
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.json': 'application/json'
};

function getAudioMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.m4a') return 'audio/mp4';
    if (ext === '.webm') return 'audio/webm';
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.ogg') return 'audio/ogg';
    return 'audio/mpeg';
}

// Start static/API server
const server = http.createServer(async (req, res) => {
    // Add CORS headers for everything
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-audio-title');
    res.setHeader('Access-Control-Expose-Headers', 'x-audio-title');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = urlModule.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // API Downloader Route
    if (pathname === '/api/download') {
        const videoUrl = parsedUrl.query.url;
        if (!videoUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Missing URL parameter');
            return;
        }

        try {
            const binaryPath = await ensureBinary();
            
            // Step 1: Query metadata
            console.log(`Fetching metadata for: ${videoUrl}`);
            const outputTemplate = path.join(__dirname, 'bin', 'temp_%(id)s.%(ext)s');
            
            getFileInfo(binaryPath, videoUrl, outputTemplate)
                .then(async (info) => {
                    console.log(`Downloading: ${info.title} -> ${info.filename}`);
                    
                    // Step 2: Download the audio
                    await downloadAudio(binaryPath, videoUrl, info.filename);
                    
                    if (!fs.existsSync(info.filename)) {
                        throw new Error('Downloaded file not found on disk');
                    }
                    
                    const stat = fs.statSync(info.filename);
                    const mimeType = getAudioMimeType(info.filename);
                    
                    res.writeHead(200, {
                        'Content-Type': mimeType,
                        'x-audio-title': encodeURIComponent(info.title),
                        'Content-Length': stat.size
                    });
                    
                    let cleaned = false;
                    const cleanup = () => {
                        if (cleaned) return;
                        cleaned = true;
                        fs.exists(info.filename, (exists) => {
                            if (exists) {
                                fs.unlink(info.filename, (err) => {
                                    if (err) console.error(`Error deleting temp file ${info.filename}:`, err);
                                    else console.log(`Deleted temp file: ${info.filename}`);
                                });
                            }
                        });
                    };

                    const readStream = fs.createReadStream(info.filename);
                    readStream.pipe(res);
                    
                    readStream.on('end', cleanup);
                    req.on('close', cleanup);
                    res.on('close', cleanup);
                })
                .catch((err) => {
                    console.error('Download failed:', err);
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end(`Download error: ${err.message}`);
                });

        } catch (err) {
            console.error('Server error:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Server error: ${err.message}`);
        }
        return;
    }

    // Serve static frontend files
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    
    // Normalize path to prevent directory traversal
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    fs.exists(filePath, (exists) => {
        if (!exists) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
            return;
        }

        const ext = path.extname(filePath);
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': mimeType });
        fs.createReadStream(filePath).pipe(res);
    });
});

// Run yt-dlp to get title and filename template
function getFileInfo(binaryPath, url, outputTemplate) {
    return new Promise((resolve, reject) => {
        execFile(binaryPath, [
            '--print', 'title',
            '--print', 'filename',
            '-f', 'bestaudio',
            '-o', outputTemplate,
            url
        ], (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            const lines = stdout.trim().split('\n');
            if (lines.length >= 2) {
                resolve({
                    title: lines[0].trim(),
                    filename: lines[1].trim()
                });
            } else {
                reject(new Error('Failed to parse yt-dlp output metadata'));
            }
        });
    });
}

// Run yt-dlp to download audio
function downloadAudio(binaryPath, url, filename) {
    return new Promise((resolve, reject) => {
        execFile(binaryPath, [
            '-f', 'bestaudio',
            '-o', filename,
            url
        ], (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            resolve();
        });
    });
}

server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Slowed & Reverb Studio backend running locally at:`);
    console.log(` http://localhost:${PORT}`);
    console.log(`===================================================`);
});
