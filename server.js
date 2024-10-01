import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = 3000;

const server = http.createServer((req, res) => {
	console.log(`リクエストを受信: ${req.url}`);

	let filePath = req.url === '/' ? '/index.html' : req.url;
	let extname = String(path.extname(filePath)).toLowerCase();
	
	// JavaScriptファイルのリクエストをdistディレクトリにリダイレクト
	if (extname === '.js' && !filePath.startsWith('/dist')) {
		filePath = '/dist' + filePath;
	}

	const fullPath = path.join(__dirname, filePath);

	const mimeTypes = {
		'.html': 'text/html',
		'.js': 'text/javascript',
		'.css': 'text/css',
		'.json': 'application/json',
		 '.png': 'image/png',
		'.jpg': 'image/jpg',
		'.gif': 'image/gif',
		'.svg': 'image/svg+xml',
		'.wav': 'audio/wav',
		'.mp4': 'video/mp4',
		 '.woff': 'application/font-woff',
		'.ttf': 'application/font-ttf',
		'.eot': 'application/vnd.ms-fontobject',
		'.otf': 'application/font-otf',
		'.wasm': 'application/wasm'
	};

	const contentType = mimeTypes[extname] || 'application/octet-stream';

	fs.readFile(fullPath, (err, content) => {
		if (err) {
			if (err.code === 'ENOENT') {
				console.error(`ファイルが見つかりません: ${fullPath}`);
				res.writeHead(404);
				res.end('ファイルが見つかりません');
			} else {
				console.error(`サーバーエラー: ${err.code}`);
				res.writeHead(500);
				res.end(`サーバーエラー: ${err.code}`);
			}
		} else {
			if (extname === '.js') {
				res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
			} else {
				res.writeHead(200, { 'Content-Type': contentType });
			}
			res.end(content, 'utf-8');
			console.log(`ファイルを正常に送信: ${fullPath}`);
		}
	});
});

server.listen(port, () => {
	console.log(`サーバーが http://localhost:${port} で起動しました`);
});