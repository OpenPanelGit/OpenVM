const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const vmManager = require('./vmManager');

const app = express();
expressWs(app);

const SECRET = 'openwin_secret_3939';
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

app.use(express.json());
app.use(cors());

// Auth Middleware
const auth = (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: 'No token provided' });
    const token = header.split(' ')[1];
    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
};

// Static files
app.use('/shared', express.static(path.join(__dirname, '..', 'Panel', 'Shared')));
app.use('/admin-panel', express.static(path.join(__dirname, '..', 'Panel', 'Admin')));
app.use('/user-panel', express.static(path.join(__dirname, '..', 'Panel', 'Users')));

app.get('/', (req, res) => res.redirect('/user-panel'));

// --- API ---

app.post('/api/install', async (req, res) => {
    const { username, password } = req.body;
    await fs.ensureDir(DATA_DIR);
    const passwordHash = bcrypt.hashSync(password, 10);
    const adminUser = { id: 1, username: username.toLowerCase(), passwordHash, role: 'admin' };
    await fs.writeJson(USERS_PATH, [adminUser]);
    await fs.writeJson(CONFIG_PATH, { installed: true });
    res.json({ success: true });
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = await fs.readJson(USERS_PATH).catch(() => []);
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET);
    res.json({ token, role: user.role });
});

// Admin API
app.get('/api/admin/users', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const users = await fs.readJson(USERS_PATH).catch(() => []);
    res.json(users.map(({ passwordHash, ...u }) => u));
});

app.post('/api/admin/users/create', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { username, password, role } = req.body;
    const users = await fs.readJson(USERS_PATH).catch(() => []);
    users.push({ id: Date.now(), username, passwordHash: bcrypt.hashSync(password, 10), role: role || 'user' });
    await fs.writeJson(USERS_PATH, users);
    res.json({ success: true });
});

app.get('/api/admin/node-info', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    res.json({
        os: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
        freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024) + ' GB',
        uptime: Math.round(os.uptime() / 3600) + ' hours'
    });
});

app.post('/api/admin/vms/create', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    try {
        const { name, ram, cpu, disk, iso, osType, password } = req.body;
        await vmManager.create(name, ram, cpu, disk, iso, osType, password);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/vms/delete', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    try {
        await vmManager.deleteVM(req.body.name);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Client API
app.get('/api/vms', auth, async (req, res) => {
    const vms = await vmManager.getVMs();
    res.json(vms);
});

app.post('/api/vms/control', auth, async (req, res) => {
    try {
        const { name, action } = req.body;
        await vmManager.control(name, action);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/vms/setup-linux', auth, async (req, res) => {
    const { name, ip, pass } = req.body;
    // Commande magique qui installe tout sans poser de questions
    const installCmd = `sudo apt update && sudo DEBIAN_FRONTEND=noninteractive apt install xrdp ubuntu-desktop -y && sudo systemctl enable xrdp && sudo systemctl start xrdp`;

    // On lance en arrière-plan via SSH (si installé sur l'hôte)
    // On utilise plink ou ssh (si dispo)
    const fullCmd = `sshpass -p '${pass}' ssh -o StrictHostKeyChecking=no root@${ip} "${installCmd}"`;

    // On répond direct "OK" pour pas bloquer l'UI, le script tournera en fond
    exec(fullCmd, (err) => {
        if (err) console.error("AUTO_SETUP_FAILED:", err.message);
    });

    res.json({ success: true, message: "Installation démarrée" });
});

// Console WS
app.ws('/api/console/:vmName', (ws, req) => {
    const vmName = req.params.vmName;
    const stages = [
        "Initialisation du tunnel WebSocket...",
        "Recherche de l'instance " + vmName + "...",
        "Vérification des droits de virtualisation...",
        "Synchronisation avec le pont RDP...",
        "Connecté au flux RDP de " + vmName
    ];

    let i = 0;
    const sendUpdate = async () => {
        if (ws.readyState !== 1) return;
        if (i < stages.length) {
            ws.send(JSON.stringify({ type: 'status', data: stages[i] }));
            i++;
        }
        try {
            const img = await vmManager.getScreenshot(vmName);
            if (img && ws.readyState === 1) {
                console.log(`[SEND_SCREEN] ${vmName} (${img.substring(0, 30)}...)`);
                ws.send(JSON.stringify({ type: 'screen', data: img }));
            } else {
                // On ne log plus "no image" pour pas spammer si le script est clean
            }
        } catch (e) { console.error("CONSOLE_ERROR:", e); }
        if (ws.readyState === 1) setTimeout(sendUpdate, 1000);
    };
    sendUpdate();
    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'input') {
                await vmManager.sendInput(vmName, data.action, data.data);
            }
        } catch (e) { }
    });

    ws.on('close', () => { });
});


const PORT = 3001;
app.listen(PORT, async () => {
    await fs.ensureDir(DATA_DIR);
    console.log(`OpenWin Core Running on port ${PORT}`);
});
