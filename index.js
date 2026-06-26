import './settings.js';
import fs from 'fs';
import os from 'os';
import dns from 'dns';
import pino from 'pino';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import cron from 'node-cron';
import readline from 'readline';
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode-terminal';
import moment from 'moment-timezone';
import { createRequire } from 'module';
import { parsePhoneNumber } from 'awesome-phonenumber';
import WAConnection, { useMultiFileAuthState, Browsers, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestWaWebVersion } from 'baileys';

import { setupDashboard } from './src/server.js';
import { assertInstalled, customHttpsAgent } from './lib/function.js';
import { dataBase, cmdDel, checkStatus, checkExpired } from './src/database.js';
import { GroupParticipantsUpdate, MessagesUpsert, Solving } from './src/message.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const print = (label, value) => console.log(`${chalk.green.bold('║')} ${chalk.cyan.bold(label.padEnd(16))}${chalk.yellow.bold(':')} ${value}`);
const pairingCode = process.argv.includes('--qr') ? false : process.argv.includes('--pairing-code') || global.pairing_code;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))
const tempDir = path.join(__dirname, 'database/temp');
const time_now = new Date();
const time_end = 60000 - (time_now.getSeconds() * 1000 + time_now.getMilliseconds());
let pairingStarted = false;
let setupServer = null;
let phoneNumber;

const userInfoSyt = () => {
	try {
		return os.userInfo().username
	} catch (e) {
		return process.env.USER || process.env.USERNAME || 'unknown';
	}
}

try {
	dns.setServers(['8.8.8.8', '1.1.1.1']);
	console.log(chalk.yellowBright('[SYSTEM] Custom DNS Google & Cloudflare.'));
} catch (e) {
	console.log(chalk.yellowBright('[SYSTEM] failed to custom DNS:'), e.message);
}

// Fetch Api
global.fetchApi = async (endpoint = '/', data = {}, options = {}) => {
	return new Promise(async (resolve, reject) => {
		try {
			const apiList = Object.keys(global.APIs);
			if (options.api !== undefined) {
				if (typeof options.api !== 'number' || options.api < 1 || options.api > apiList.length) {
					return reject(new Error(`[Fetch Error] Parameter { api: ${options.api} } tidak terdaftar. Harap gunakan angka 1 hingga ${apiList.length}.`));
				}
			}
			const apiName = typeof options.api === 'number' ? apiList[options.api - 1] : options.name
			const base = apiName ? (global.APIs[apiName] || apiName) : global.APIs.naze
			const apikey = global.APIKeys[base] || '';
			let method = (options.method || 'GET').toUpperCase()
			let url = base + endpoint 
			let payload = null
			let headers = options.headers || { 'user-agent': 'Mozilla/5.0 (Linux; Android 15)' }
			const isForm = options.form || data instanceof FormData || (data && typeof data.getHeaders === 'function');
			if (isForm) {
				payload = data
				method = 'POST'
				headers = { ...(options.headers?.['Authorization'] ? {} : { apikey }), ...headers, ...data.getHeaders() }
			} else if (method !== 'GET') {
				payload = { ...data, ...(options.headers?.['Authorization'] ? {} : { apikey }) }
				headers['content-type'] = 'application/json'
			} else {
				url += '?' + new URLSearchParams({ ...data, apikey }).toString()
			}
			const res = await axios({
				method, url, data: payload,
				headers, httpsAgent: customHttpsAgent,
				responseType: options.stream ? 'stream' : (options.buffer ? 'arraybuffer' : options.responseType || options.type || 'json'),
			});
			if (options.stream) {
				let ext = options.ext
				if (typeof options.stream !== 'string' && !ext) {
					const contentDisp = res.headers['content-disposition']
					const contentType = res.headers['content-type']
					if (contentDisp && contentDisp.includes('filename=')) {
						const match = contentDisp.match(/filename="?([^"]+)"?/)
						if (match && match[1]) {
							ext = match[1].split('.').pop()
						}
					}
					if (!ext && contentType) {
						ext = contentType.split('/')[1]?.split(';')[0]
						if (ext === 'jpeg') ext = 'jpg'
					}
					ext = ext || 'tmp'
				}
				let streamPath = typeof options.stream === 'string' ? options.stream : path.join(process.cwd(), 'database/temp', 'temp-' + Date.now() + '.' + ext)
				const writeStream = fs.createWriteStream(streamPath)
				res.data.pipe(writeStream)
				writeStream.on('finish', () => resolve(streamPath))
				writeStream.on('error', reject)
			} else {
				resolve(options.buffer ? Buffer.from(res.data) : res.data)
			}
		} catch (e) {
			reject(e)
		}
	})
}

const storeDB = dataBase(global.tempatStore);
const database = dataBase(global.tempatDB);
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60, useClones: false });

if (fs.existsSync(tempDir)) {
	fs.readdirSync(tempDir).forEach(file => {
		fs.unlinkSync(path.join(tempDir, file));
	});
	console.log(chalk.greenBright('[SYSTEM] Temp folder cleared successfully!'));
} else {
	fs.mkdirSync(tempDir, { recursive: true });
}

assertInstalled(process.platform === 'win32' ? 'where ffmpeg' : 'command -v ffmpeg', 'FFmpeg', 0);
console.log(chalk.greenBright('✅  All external dependencies are satisfied'));
console.log(chalk.green.bold(`╔═════[${`${chalk.cyan(userInfoSyt())}@${chalk.cyan(os.hostname())}`}]═════`));
print('OS', `${os.platform()} ${os.release()} ${os.arch()}`);
print('Uptime', `${Math.floor(os.uptime() / 3600)} h ${Math.floor((os.uptime() % 3600) / 60)} m`);
print('Shell', process.env.SHELL || process.env.COMSPEC || 'unknown');
print('CPU', os.cpus()[0]?.model.trim() || 'unknown');
print('Memory', `${(os.freemem()/1024/1024).toFixed(0)} MiB / ${(os.totalmem()/1024/1024).toFixed(0)} MiB`);
print('Script version', `v${require('./package.json').version}`);
print('Node.js', process.version);
print('Baileys', `v${require('./package.json').dependencies.baileys}`);
print('Date & Time', new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta', hour12: false }));
console.log(chalk.green.bold('╚' + ('═'.repeat(30))));

async function startNazeBot() {
	try {
		const loadData = await database.read()
		const storeLoadData = await storeDB.read()
		if (!loadData || Object.keys(loadData).length === 0) {
			global.db = {
				hit: {},
				set: {},
				cmd: {},
				store: {},
				users: {},
				game: {},
				groups: {},
				database: {},
				premium: [],
				sewa: [],
				...(loadData || {}),
			}
			await database.write(global.db)
		} else {
			global.db = loadData
		}
		if (!storeLoadData || Object.keys(storeLoadData).length === 0) {
			global.store = {
				contacts: {},
				presences: {},
				messages: {},
				groupMetadata: {},
				...(storeLoadData || {}),
			}
			await storeDB.write(global.store)
		} else {
			global.store = storeLoadData
		}
		
		global.loadMessage = function (remoteJid, id) {
			const messages = store.messages?.[remoteJid]?.array;
			if (!messages) return null;
			return messages.find(msg => msg?.key?.id === id) || null;
		}
		
		if (!global._dbInterval) {
			global._dbInterval = setInterval(async () => {
				if (global.db) await database.write(global.db)
				if (global.store) await storeDB.write(global.store)
			}, 30 * 1000)
		}
	} catch (e) {
		console.log(e)
		process.exit(1)
	}
	
	const level = pino({ level: 'silent' });
	const { version } = await fetchLatestWaWebVersion();
	if (pairingCode && !phoneNumber && !fs.existsSync('./nazedev/creds.json')) {
		fs.rmSync('./nazedev', { recursive: true, force: true });
		async function getPhoneNumber() {
			phoneNumber = global.number_bot ? global.number_bot : process.env.BOT_NUMBER || await question('Please type your WhatsApp number : ');
			phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
			if (!parsePhoneNumber('+' + phoneNumber).valid && phoneNumber.length < 6) {
				console.log(chalk.bgBlack(chalk.redBright('Start with your Country WhatsApp code') + chalk.whiteBright(',') + chalk.greenBright(' Example : 62xxx')));
				await getPhoneNumber();
			}
		}
		await getPhoneNumber();
		console.log('Phone number captured. Waiting for Connection...\n' + chalk.blueBright('Estimated time: around 2 ~ 5 minutes'));
	}
	const { state, saveCreds } = await useMultiFileAuthState('nazedev');
	const getMessage = async (key) => {
		if (global.store) {
			const msg = await global.loadMessage(key.remoteJid, key.id);
			return msg?.message || ''
		}
		return {
			conversation: 'Halo Saya Naze Bot'
		}
	}
	
	// Connector
	const naze = WAConnection({
		version,
		logger: level,
		getMessage,
		syncFullHistory: false,
		maxMsgRetryCount: 15,
		msgRetryCounterCache,
		retryRequestDelayMs: 10,
		defaultQueryTimeoutMs: 0,
		connectTimeoutMs: 60000,
		keepAliveIntervalMs: 30000,
		browser: Browsers.ubuntu('Chrome'),
		generateHighQualityLinkPreview: false,
		transactionOpts: {
			maxCommitRetries: 10,
			delayBetweenTriesMs: 10,
		},
		appStateMacVerification: {
			patch: true,
			snapshot: true,
		},
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, level),
		},
	});
	
	await Solving(naze, global.store)
	
	naze.ev.on('creds.update', saveCreds)
	
	naze.ev.on('connection.update', async (update) => {
		const { qr, connection, lastDisconnect, isNewLogin, receivedPendingNotifications } = update;
		if ((connection === 'connecting' || !!qr) && pairingCode && phoneNumber && !naze.authState.creds.registered && !pairingStarted) {
			pairingStarted = true;
			setTimeout(async () => {
				try {
					console.log('Requesting Pairing Code...')
					let code = await naze.requestPairingCode(phoneNumber);
					console.log(chalk.blue('Your Pairing Code :'), chalk.green(code), '\n', chalk.yellow('Expires in 15 second'));
				} catch (err) {
					console.log(chalk.redBright('[ERROR] Failed to retrieve the Pairing Code:'), err.message);
					pairingStarted = false;
				}
			}, 3000)
		}
		if (connection === 'close') {
			pairingStarted = false;
			const reason = new Boom(lastDisconnect?.error)?.output.statusCode
			if (reason === DisconnectReason.connectionLost) {
				console.log('Connection to Server Lost, Attempting to Reconnect...');
				startNazeBot()
			} else if (reason === DisconnectReason.connectionClosed) {
				console.log('Connection closed, Attempting to Reconnect...');
				startNazeBot()
			} else if (reason === DisconnectReason.restartRequired) {
				console.log('Restart Required...');
				startNazeBot()
			} else if (reason === DisconnectReason.timedOut) {
				console.log('Connection Timed Out, Attempting to Reconnect...');
				startNazeBot()
			} else if (reason === DisconnectReason.badSession) {
				console.log('Delete Session and Scan again...');
				startNazeBot()
			} else if (reason === DisconnectReason.connectionReplaced) {
				console.log('Close current Session first...');
			} else if (reason === DisconnectReason.loggedOut) {
				console.log('Scan again and Run...');
				fs.rmSync('./nazedev', { recursive: true, force: true });
				process.exit(0)
			} else if (reason === DisconnectReason.forbidden) {
				console.log('Connection Failure, Scan again and Run...');
				fs.rmSync('./nazedev', { recursive: true, force: true });
				process.exit(1)
			} else if (reason === DisconnectReason.multideviceMismatch) {
				console.log('Scan again...');
				fs.rmSync('./nazedev', { recursive: true, force: true });
				process.exit(0)
			} else {
				naze.end(`Unknown DisconnectReason : ${reason}|${connection}`)
			}
		}
		if (connection == 'open') {
			console.log('Connected to : ' + JSON.stringify(naze.user, null, 2));
			let botNumber = await naze.decodeJid(naze.user.id);
			if (global.db?.set[botNumber] && !global.db?.set[botNumber]?.join) {
				if (my.ch.length > 0 && my.ch.includes('@newsletter')) {
					if (my.ch) await naze.newsletterMsg(my.ch, { type: 'follow' }).catch(e => {})
					db.set[botNumber].join = true
				}
			}
		}
		if (qr) {
			if (!pairingCode) qrcode.generate(qr, { small: true });
		}
		if (isNewLogin) console.log(chalk.green('[INFO] New device login detected...'))
		if (receivedPendingNotifications == 'true') {
			console.log(chalk.green('[INFO] Please wait About 1 Minute...'))
			naze.ev.flush()
		}
	});
	
	naze.ev.on('call', async (call) => {
		let botNumber = await naze.decodeJid(naze.user.id);
		if (global.db?.set[botNumber]?.anticall) {
			for (let id of call) {
				if (id.status === 'offer') {
					let msg = await naze.sendMessage(id.from, { text: `Saat Ini, Kami Tidak Dapat Menerima Panggilan ${id.isVideo ? 'Video' : 'Suara'}.\nJika @${id.from.split('@')[0]} Memerlukan Bantuan, Silakan Hubungi Owner :)`, mentions: [id.from]});
					await naze.sendContact(id.from, global.owner, msg);
					await naze.rejectCall(id.id, id.from)
				}
			}
		}
	});
	
	naze.ev.on('messages.upsert', async (message) => {
		await MessagesUpsert(naze, message, global.store);
	});
	
	naze.ev.on('group-participants.update', async (update) => {
		await GroupParticipantsUpdate(naze, update, global.store);
	});
	
	naze.ev.on('groups.update', (update) => {
		for (const n of update) {
			if (global.store.groupMetadata[n.id]) {
				Object.assign(global.store.groupMetadata[n.id], n);
			} else global.store.groupMetadata[n.id] = n;
		}
	});
	
	naze.ev.on('presence.update', (update) => {
		const { id, presences } = update;
		global.store.presences[id] = global.store.presences?.[id] || {};
		Object.assign(global.store.presences[id], presences);
	});
	
	// Reset Limit & Backup
	cron.schedule('00 00 * * *', async () => {
		cmdDel(global.db.hit);
		console.log(chalk.cyan('[INFO] Reseted Limit Users'));
		let user = Object.keys(global.db.users)
		let botNumber = await naze.decodeJid(naze.user.id);
		for (let jid of user) {
			const limitUser = global.db.users[jid].vip ? global.limit.vip : checkStatus(jid, global.db.premium) ? global.limit.premium : global.limit.free
			if (global.db.users[jid].limit < limitUser) global.db.users[jid].limit = limitUser
		}
		if (global.db?.set[botNumber].autobackup) {
			let datanya = './database/' + global.tempatDB;
			if (global.tempatDB.startsWith('mongodb')) {
				datanya = './database/backup_database.json';
				fs.writeFileSync(datanya, JSON.stringify(global.db, null, 2), 'utf-8');
			}
			for (let o of ownerNumber) {
				try {
					await naze.sendMessage(o, { document: fs.readFileSync(datanya), mimetype: 'application/json', fileName: new Date().toISOString().replace(/[:.]/g, '-') + '_database.json' })
					console.log(chalk.cyanBright(`[AUTO BACKUP] Backup success send to ${o}`));
				} catch (error) {
					console.error(chalk.cyanBright(`[AUTO BACKUP] Failed to Sending Backup ${o}:`, error));
				}
			}
		}
	}, {
		scheduled: true,
		timezone: global.timezone
	});
	
	// Waktu Sholat
	if (!global.intervalSholat) global.intervalSholat = null;
	if (!global.waktusholat) global.waktusholat = {};
	if (global.intervalSholat) clearInterval(global.intervalSholat); 
	setTimeout(() => {
		global.intervalSholat = setInterval(async() => {
			const sekarang = moment.tz(global.timezone);
			const jamSholat = sekarang.format('HH:mm');
			const hariIni = sekarang.format('YYYY-MM-DD');
			const detik = sekarang.format('ss');
			if (detik !== '00') return;
			for (const [sholat, waktu] of Object.entries(global.jadwalSholat)) {
				if (jamSholat === waktu && global.waktusholat[sholat] !== hariIni) {
					global.waktusholat[sholat] = hariIni
					for (const [idnya, settings] of Object.entries(global.db.groups)) {
						if (settings.waktusholat) {
							await naze.sendMessage(idnya, { text: `Waktu *${sholat}* telah tiba, ambilah air wudhu dan segeralah shalat🙂.\n\n*${waktu.slice(0, 5)}*\n_untuk wilayah ${global.timezone} dan sekitarnya._` }, { ephemeralExpiration: store?.messages[idnya]?.array?.slice(-1)[0]?.metadata?.ephemeralDuration || 0 }).catch(e => {})
						}
					}
				}
			}
		}, 60000)
	}, time_end);
	
	if (!global._dbPresence) {
		if (global?.db?.premium) checkExpired(global.db.premium);
		if (global?.db?.sewa && naze?.user?.id) checkExpired(global.db.sewa, naze);
		global._dbPresence = setInterval(async () => {
			if (naze?.user?.id) await naze.sendPresenceUpdate('available', naze.decodeJid(naze.user.id)).catch(e => {});
		}, 60 * 60 * 1000);
	}

	if (!setupServer && database && naze) {
		setupServer = await setupDashboard(database, storeDB, naze);
	}

	return naze
}

startNazeBot()

const cleanup = async (signal) => {
	console.log(chalk.greenBright(`[SYSTEM] Received ${signal}. Menyimpan database...`));
	if (global.db) await database.write(global.db)
	if (global.store) await storeDB.write(global.store)
	console.log('Menutup sistem. Exiting...')
	process.exit(0)
}

process.on('uncaughtException', function (err) {
  console.error(chalk.redBright('[UNCAUGHT EXCEPTION]'), err);
});

process.on('unhandledRejection', function (err) {
  console.error(chalk.redBright('[UNHANDLED REJECTION]'), err);
});

process.on('SIGINT', () => cleanup('SIGINT'))
process.on('SIGTERM', () => cleanup('SIGTERM'))
process.on('exit', () => cleanup('exit'))
