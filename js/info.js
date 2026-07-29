// ForFilm 信息墙 (Pro 固件专用 - 设备直连)
// 通过 BLE 0x3E-0x4C 控制设备信息墙, 设备直接请求 MC/AI/SRV API
// 含 E-paper 预览 Canvas 渲染 + 背景图支持

// ===== 设备端信息墙状态 =====
let deviceInfoEnable = 0;
let deviceInfoMcHost = '';
let deviceInfoMcPort = 25565;
let deviceInfoMcUrl = '';
let deviceInfoAiUrl = '';
let deviceInfoAiToken = '';
let deviceInfoSrvUrl = '';
let deviceInfoRefreshMin = 0;
let deviceInfoPage = 0;

// ===== 背景图管理 =====
const bgImages = { mc: null, ai: null, srv: null };
const bgCache = {};

// ===== E-paper 调色板 (6色, 匹配固件) =====
const PALETTE = {
    0x00: '#1a1a1a', // Black
    0x01: '#e8e4e0', // White (paper)
    0x02: '#d4a520', // Yellow
    0x03: '#c0392b', // Red
    0x05: '#2980b9', // Blue
    0x06: '#27ae60', // Green
};

// ===== 颜色映射到6色调色板 =====
function mapToPalette(r, g, b) {
    const colors = [
        { id: 0x00, r: 26, g: 26, b: 26 },
        { id: 0x01, r: 232, g: 228, b: 224 },
        { id: 0x02, r: 212, g: 165, b: 32 },
        { id: 0x03, r: 192, g: 57, b: 43 },
        { id: 0x05, r: 41, g: 128, b: 185 },
        { id: 0x06, r: 39, g: 174, b: 96 },
    ];
    let minDist = Infinity, closest = 0x01;
    for (const c of colors) {
        const dr = r - c.r, dg = g - c.g, db = b - c.b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < minDist) { minDist = dist; closest = c.id; }
    }
    return closest;
}

// ===== 背景图上传处理 =====
function handleBgUpload(page, input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        bgImages[page] = e.target.result;
        delete bgCache[page];
        document.getElementById(page + '-bg-clear').style.display = 'inline-flex';
        if (page === 'mc') mcPreviewRender();
        else if (page === 'ai') aiPreviewRender();
        else if (page === 'srv') srvPreviewRender();
    };
    reader.readAsDataURL(file);
}

function clearBgImage(page) {
    bgImages[page] = null;
    delete bgCache[page];
    document.getElementById(page + '-bg-upload').value = '';
    document.getElementById(page + '-bg-clear').style.display = 'none';
    if (page === 'mc') mcPreviewRender();
    else if (page === 'ai') aiPreviewRender();
    else if (page === 'srv') srvPreviewRender();
}

async function getProcessedBg(page) {
    if (bgCache[page]) return bgCache[page];
    if (!bgImages[page]) return null;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 792; tempCanvas.height = 528;
    const tempCtx = tempCanvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = bgImages[page];
    return new Promise(function(resolve) {
        img.onload = function() {
            const imgRatio = img.width / img.height;
            const targetRatio = 792 / 528;
            let sx, sy, sw, sh;
            if (imgRatio > targetRatio) {
                sh = img.height;
                sw = img.height * targetRatio;
                sx = (img.width - sw) / 2;
                sy = 0;
            } else {
                sw = img.width;
                sh = img.width / targetRatio;
                sx = 0;
                sy = (img.height - sh) / 2;
            }
            tempCtx.drawImage(img, sx, sy, sw, sh, 0, 0, 792, 528);
            const imgData = tempCtx.getImageData(0, 0, 792, 528);
            const data = imgData.data;
            for (let i = 0; i < data.length; i += 4) {
                const mapped = mapToPalette(data[i], data[i+1], data[i+2]);
                const c = PALETTE[mapped];
                data[i] = parseInt(c.slice(1,3),16);
                data[i+1] = parseInt(c.slice(3,5),16);
                data[i+2] = parseInt(c.slice(5,7),16);
                data[i+3] = 255;
            }
            tempCtx.putImageData(imgData, 0, 0);
            bgCache[page] = tempCanvas;
            resolve(tempCanvas);
        };
        img.onerror = function() { resolve(null); };
    });
}

// ===== EpdRenderer =====
const EpdRenderer = {
    ctx: null, W: 792, H: 528,
    init(canvasId) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return false;
        canvas.width = this.W; canvas.height = this.H;
        this.ctx = canvas.getContext('2d');
        return true;
    },
    clear(color) {
        this.ctx.fillStyle = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.fillRect(0, 0, this.W, this.H);
    },
    fillRect(x, y, w, h, color) {
        this.ctx.fillStyle = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.fillRect(x, y, w, h);
    },
    drawRect(x, y, w, h, color) {
        this.ctx.strokeStyle = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    },
    drawHline(x, y, w, color) {
        this.ctx.fillStyle = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.fillRect(x, y, w, 1);
    },
    drawText(x, y, s, color, bg, scale) {
        const sc = scale || 1;
        const c = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.font = (sc * 6.5) + 'px Consolas, monospace';
        this.ctx.textBaseline = 'top';
        if (bg !== undefined && bg !== null) {
            this.ctx.fillStyle = (typeof bg === 'number' ? (PALETTE[bg] || PALETTE[0x01]) : bg);
            const m = this.ctx.measureText(s);
            this.ctx.fillRect(x, y, m.width, sc * 8);
        }
        this.ctx.fillStyle = c; this.ctx.fillText(s, x, y);
    },
    drawTextCenter(cx, y, s, color, bg, scale) {
        const sc = scale || 1;
        this.ctx.font = (sc * 6.5) + 'px Consolas, monospace';
        this.ctx.textBaseline = 'top';
        const m = this.ctx.measureText(s);
        const x = cx - m.width / 2;
        if (bg !== undefined && bg !== null) {
            this.ctx.fillStyle = (typeof bg === 'number' ? (PALETTE[bg] || PALETTE[0x01]) : bg);
            this.ctx.fillRect(x, y, m.width, sc * 8);
        }
        this.ctx.fillStyle = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.fillText(s, x, y);
    },
    drawBadge(x, y, txt, fg, bg) {
        const fgc = (typeof fg === 'number' ? (PALETTE[fg] || PALETTE[0x01]) : fg);
        const bgc = (typeof bg === 'number' ? (PALETTE[bg] || PALETTE[0x01]) : bg);
        this.ctx.font = '13px Consolas, monospace'; this.ctx.textBaseline = 'top';
        const m = this.ctx.measureText(txt);
        const pw = 12, ph = 4, bw = m.width + pw * 2, bh = 13 + ph * 2, r = 6;
        this.ctx.fillStyle = bgc;
        this.ctx.beginPath();
        this.ctx.moveTo(x + r, y); this.ctx.lineTo(x + bw - r, y);
        this.ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
        this.ctx.lineTo(x + bw, y + bh - r); this.ctx.quadraticCurveTo(x + bw, y + bh, x + bw - r, y + bh);
        this.ctx.lineTo(x + r, y + bh); this.ctx.quadraticCurveTo(x, y + bh, x, y + bh - r);
        this.ctx.lineTo(x, y + r); this.ctx.quadraticCurveTo(x, y, x + r, y);
        this.ctx.closePath(); this.ctx.fill();
        this.ctx.fillStyle = fgc; this.ctx.fillText(txt, x + pw, y + ph);
    },
    drawAvatar(x, y, size, initial, color) {
        const c = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        const r = size / 2;
        this.ctx.fillStyle = c;
        this.ctx.beginPath(); this.ctx.arc(x + r, y + r, r, 0, Math.PI * 2); this.ctx.closePath(); this.ctx.fill();
        this.ctx.fillStyle = PALETTE[0x01];
        this.ctx.font = (size * 0.55) + 'px Consolas, monospace';
        this.ctx.textBaseline = 'middle'; this.ctx.textAlign = 'center';
        this.ctx.fillText(initial, x + r, y + r + 1);
        this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
    },
    drawCanvas(srcCanvas, x, y, w, h) {
        if (!srcCanvas) return;
        if (w && h) this.ctx.drawImage(srcCanvas, x, y, w, h);
        else this.ctx.drawImage(srcCanvas, x, y);
    },
    fillRoundRect(x, y, w, h, radius, color) {
        const c = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        const r = radius;
        this.ctx.fillStyle = c;
        this.ctx.beginPath();
        this.ctx.moveTo(x + r, y);
        this.ctx.lineTo(x + w - r, y);
        this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        this.ctx.lineTo(x + w, y + h - r);
        this.ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        this.ctx.lineTo(x + r, y + h);
        this.ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        this.ctx.lineTo(x, y + r);
        this.ctx.quadraticCurveTo(x, y, x + r, y);
        this.ctx.closePath();
        this.ctx.fill();
    },
    drawRoundRect(x, y, w, h, radius, color) {
        const c = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        const r = radius;
        this.ctx.strokeStyle = c;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(x + r, y + 0.5);
        this.ctx.lineTo(x + w - r, y + 0.5);
        this.ctx.quadraticCurveTo(x + w + 0.5, y + 0.5, x + w + 0.5, y + r);
        this.ctx.lineTo(x + w + 0.5, y + h - r);
        this.ctx.quadraticCurveTo(x + w + 0.5, y + h + 0.5, x + w - r, y + h + 0.5);
        this.ctx.lineTo(x + r, y + h + 0.5);
        this.ctx.quadraticCurveTo(x + 0.5, y + h + 0.5, x + 0.5, y + h - r);
        this.ctx.lineTo(x + 0.5, y + r);
        this.ctx.quadraticCurveTo(x + 0.5, y + 0.5, x + r, y + 0.5);
        this.ctx.closePath();
        this.ctx.stroke();
    },
    fillCircle(cx, cy, r, color) {
        const c = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.fillStyle = c;
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
        this.ctx.closePath();
        this.ctx.fill();
    },
    drawVline(x, y, h, color) {
        this.ctx.fillStyle = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.fillRect(x, y, 1, h);
    },
    drawTextRight(rx, y, s, color, bg, scale) {
        const sc = scale || 1;
        this.ctx.font = (sc * 6.5) + 'px Consolas, monospace';
        this.ctx.textBaseline = 'top';
        const m = this.ctx.measureText(s);
        const x = rx - m.width;
        if (bg !== undefined && bg !== null) {
            this.ctx.fillStyle = (typeof bg === 'number' ? (PALETTE[bg] || PALETTE[0x01]) : bg);
            this.ctx.fillRect(x, y, m.width, sc * 8);
        }
        this.ctx.fillStyle = (typeof color === 'number' ? (PALETTE[color] || PALETTE[0x01]) : color);
        this.ctx.fillText(s, x, y);
    },
    measureText(s, scale) {
        const sc = scale || 1;
        this.ctx.font = (sc * 6.5) + 'px Consolas, monospace';
        return this.ctx.measureText(s).width;
    },
    drawImage(imgData) {
        if (!imgData) return;
        const img = new Image();
        img.onload = () => {
            this.ctx.drawImage(img, 0, 0, this.W, this.H);
        };
        img.src = imgData;
    },
    drawCard(x, y, w, h, r, bg, border) {
        const bgc = (typeof bg === 'number' ? (PALETTE[bg] || PALETTE[0x01]) : bg);
        const bdc = (typeof border === 'number' ? (PALETTE[border] || PALETTE[0x01]) : border);
        this.fillRoundRect(x, y, w, h, r, bgc);
        this.drawRoundRect(x, y, w, h, r, bdc);
    },
    drawProgressBar(x, y, w, h, r, ratio, color) {
        if (ratio === 0) ratio = 1;
        if (ratio > 100) ratio = 100;
        this.fillRoundRect(x, y, w, h, r, PALETTE[0x00]);
        const fillW = Math.max(2, Math.floor((w - 2) * ratio / 100));
        let barColor = color;
        if (ratio > 85) barColor = 0x03;
        else if (ratio > 70) barColor = 0x02;
        const bc = (typeof barColor === 'number' ? (PALETTE[barColor] || PALETTE[0x01]) : barColor);
        this.fillRoundRect(x + 1, y + 1, fillW, h - 2, Math.max(1, r - 1), bc);
    }
};

// ===== 布局配置系统 =====
const DEFAULT_MC_LAYOUT = {
    headerBar: { y: 0, h: 60, visible: true, label: '顶部标题栏', type: 'bar' },
    title:     { x: 20, y: 18, scale: 3, visible: true, label: '标题', type: 'text' },
    pageNum:   { x: 740, y: 22, scale: 2, visible: true, label: '页码', type: 'text' },
    statusBadge:{ x: 20, y: 75, scale: 1, visible: true, label: '状态徽章', type: 'badge' },
    playerCount:{ x: 396, y: 160, scale: 8, visible: true, label: '玩家数', type: 'text-center' },
    host:      { x: 396, y: 280, scale: 2, visible: true, label: '主机名', type: 'text-center' },
    version:   { x: 396, y: 310, scale: 2, visible: true, label: '版本', type: 'text-center' },
    divider:   { x: 20, y: 370, w: 752, visible: true, label: '分割线', type: 'hline' },
    timestamp: { x: 20, y: 390, scale: 1, visible: true, label: '时间戳', type: 'text' },
    avatars:   { x: 20, y: 420, size: 40, gap: 10, visible: true, label: '玩家头像', type: 'avatars' },
};
const DEFAULT_AI_LAYOUT = {
    headerBar: { y: 0, h: 60, visible: true, label: '顶部标题栏', type: 'bar' },
    title:     { x: 20, y: 18, scale: 3, visible: true, label: '标题', type: 'text' },
    pageNum:   { x: 740, y: 22, scale: 2, visible: true, label: '页码', type: 'text' },
    statusBadge:{ x: 20, y: 75, scale: 1, visible: true, label: '状态徽章', type: 'badge' },
    balance:   { x: 396, y: 170, scale: 10, visible: true, label: '余额', type: 'text-center' },
    divider:   { x: 20, y: 370, w: 752, visible: true, label: '分割线', type: 'hline' },
    timestamp: { x: 20, y: 390, scale: 1, visible: true, label: '时间戳', type: 'text' },
};

let mcLayout = JSON.parse(JSON.stringify(DEFAULT_MC_LAYOUT));
let aiLayout = JSON.parse(JSON.stringify(DEFAULT_AI_LAYOUT));
let currentEditPage = null;

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function saveLayout(page, layout) {
    try { localStorage.setItem('framefilm_layout_' + page, JSON.stringify(layout)); } catch(e){}
}

function loadLayout(page) {
    try {
        const raw = localStorage.getItem('framefilm_layout_' + page);
        return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
}

const savedMc = loadLayout('mc');
const savedAi = loadLayout('ai');
if (savedMc) mcLayout = savedMc;
if (savedAi) aiLayout = savedAi;

// ===== 布局编辑抽屉 =====
function openLayoutEditor(page) {
    currentEditPage = page;
    document.getElementById('layout-drawer-overlay').style.display = 'block';
    document.getElementById('layout-drawer').style.display = 'flex';
    document.getElementById('layout-drawer-title').textContent = (page === 'mc' ? 'MC' : 'AI') + ' 布局调整';
    renderLayoutEditor();
}

function closeLayoutEditor() {
    document.getElementById('layout-drawer-overlay').style.display = 'none';
    document.getElementById('layout-drawer').style.display = 'none';
    currentEditPage = null;
}

function renderLayoutEditor() {
    const body = document.getElementById('layout-drawer-body');
    if (!body || !currentEditPage) return;
    const layout = currentEditPage === 'mc' ? mcLayout : aiLayout;
    let html = '';
    for (const key in layout) {
        const item = layout[key];
        html += '<div class="layout-row">';
        html += '<div class="layout-row-toggle"><label class="switch"><input type="checkbox" ' + (item.visible ? 'checked' : '') + ' onchange="updateLayoutValue(\'' + currentEditPage + '\', \'' + key + '\', \'visible\', this.checked)"><span class="slider-toggle"></span></label></div>';
        html += '<div class="layout-row-name">' + item.label + '</div>';
        html += '<div class="layout-row-sliders">';
        if (item.x !== undefined) {
            html += '<div class="layout-slider-group"><label>X</label><input type="range" min="0" max="792" value="' + item.x + '" oninput="updateLayoutValue(\'' + currentEditPage + '\', \'' + key + '\', \'x\', this.value); this.nextElementSibling.textContent=this.value"><span class="slider-val">' + item.x + '</span></div>';
        }
        if (item.y !== undefined) {
            html += '<div class="layout-slider-group"><label>Y</label><input type="range" min="0" max="528" value="' + item.y + '" oninput="updateLayoutValue(\'' + currentEditPage + '\', \'' + key + '\', \'y\', this.value); this.nextElementSibling.textContent=this.value"><span class="slider-val">' + item.y + '</span></div>';
        }
        if (item.scale !== undefined) {
            html += '<div class="layout-slider-group"><label>大小</label><input type="range" min="1" max="15" value="' + item.scale + '" oninput="updateLayoutValue(\'' + currentEditPage + '\', \'' + key + '\', \'scale\', this.value); this.nextElementSibling.textContent=this.value"><span class="slider-val">' + item.scale + '</span></div>';
        }
        if (item.size !== undefined) {
            html += '<div class="layout-slider-group"><label>尺寸</label><input type="range" min="20" max="80" value="' + item.size + '" oninput="updateLayoutValue(\'' + currentEditPage + '\', \'' + key + '\', \'size\', this.value); this.nextElementSibling.textContent=this.value"><span class="slider-val">' + item.size + '</span></div>';
        }
        if (item.gap !== undefined) {
            html += '<div class="layout-slider-group"><label>间距</label><input type="range" min="0" max="30" value="' + item.gap + '" oninput="updateLayoutValue(\'' + currentEditPage + '\', \'' + key + '\', \'gap\', this.value); this.nextElementSibling.textContent=this.value"><span class="slider-val">' + item.gap + '</span></div>';
        }
        if (item.w !== undefined) {
            html += '<div class="layout-slider-group"><label>宽度</label><input type="range" min="0" max="792" value="' + item.w + '" oninput="updateLayoutValue(\'' + currentEditPage + '\', \'' + key + '\', \'w\', this.value); this.nextElementSibling.textContent=this.value"><span class="slider-val">' + item.w + '</span></div>';
        }
        if (item.h !== undefined) {
            html += '<div class="layout-slider-group"><label>高度</label><input type="range" min="0" max="528" value="' + item.h + '" oninput="updateLayoutValue(\'' + currentEditPage + '\', \'' + key + '\', \'h\', this.value); this.nextElementSibling.textContent=this.value"><span class="slider-val">' + item.h + '</span></div>';
        }
        html += '</div></div>';
    }
    body.innerHTML = html;
}

function updateLayoutValue(page, key, field, val) {
    const layout = page === 'mc' ? mcLayout : aiLayout;
    if (!layout[key]) return;
    if (field === 'visible') layout[key][field] = !!val;
    else layout[key][field] = parseInt(val, 10) || parseFloat(val) || 0;
    saveLayout(page, layout);
    if (page === 'mc') mcPreviewRender();
    else aiPreviewRender();
}

function resetLayoutToDefault() {
    if (!currentEditPage) return;
    if (currentEditPage === 'mc') {
        mcLayout = deepClone(DEFAULT_MC_LAYOUT);
        saveLayout('mc', mcLayout);
        mcPreviewRender();
    } else {
        aiLayout = deepClone(DEFAULT_AI_LAYOUT);
        saveLayout('ai', aiLayout);
        aiPreviewRender();
    }
    renderLayoutEditor();
}

// ===== Mojang 皮肤获取 =====
const skinCache = {};

async function fetchMojangSkin(username) {
    if (skinCache[username]) return skinCache[username];
    try {
        // 1. 获取 UUID
        const uuidRes = await fetch('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(username));
        if (!uuidRes.ok) return null;
        const uuidData = await uuidRes.json();
        const uuid = uuidData.id;
        // 2. 获取皮肤 URL
        const profileRes = await fetch('https://sessionserver.mojang.com/session/minecraft/profile/' + uuid);
        if (!profileRes.ok) return null;
        const profile = await profileRes.json();
        const skinProp = profile.properties.find(p => p.name === 'textures');
        if (!skinProp) return null;
        const textures = JSON.parse(decodeURIComponent(skinProp.value));
        const skinUrl = textures.SKIN.url;
        // 3. 加载皮肤图片
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = skinUrl;
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('Skin image load failed'));
        });
        skinCache[username] = img;
        return img;
    } catch (e) {
        return null;
    }
}

async function processSkinHead(skinImg, size) {
    const headCanvas = document.createElement('canvas');
    headCanvas.width = size;
    headCanvas.height = size;
    const ctx = headCanvas.getContext('2d');
    // 皮肤头部区域: 左上角 8x8 像素, 用最近邻插值放大
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(skinImg, 0, 0, 8, 8, 0, 0, size, size);
    // 离散化到 6 色调色板
    const imgData = ctx.getImageData(0, 0, size, size);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
        const mapped = mapToPalette(data[i], data[i+1], data[i+2]);
        const c = PALETTE[mapped];
        data[i] = parseInt(c.slice(1,3),16);
        data[i+1] = parseInt(c.slice(3,5),16);
        data[i+2] = parseInt(c.slice(5,7),16);
        data[i+3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return headCanvas;
}

async function getSkinHeadForPlayer(username, size) {
    const cacheKey = username + '_' + size;
    if (skinCache['processed_' + cacheKey]) return skinCache['processed_' + cacheKey];
    const skinImg = await fetchMojangSkin(username);
    if (!skinImg) return null;
    const processed = await processSkinHead(skinImg, size);
    skinCache['processed_' + cacheKey] = processed;
    return processed;
}

// ===== 模拟数据 =====
const MC_SAMPLE_PLAYERS = ["Steve", "Alex", "Notch", "Dream", "Phil", "Karl", "Luna", "Mika", "Emma", "Jack", "Lily", "Max", "Zoe", "Leo", "Mia"];
const AVATAR_COLORS = [0x05, 0x06, 0x02, 0x03, 0x00, 0x05, 0x06, 0x02, 0x03, 0x00, 0x05, 0x06, 0x02, 0x03, 0x00];

function getMcMockData() {
    return {
        host: (document.getElementById('info-mc-host-input') || {}).value || 'mc.example.com',
        name: 'My Survival Server',
        status: 'ONLINE',
        players_online: 12,
        players_max: 20,
        version: '1.21.1',
        motd: 'Welcome to our Minecraft Server!\nSurvival gameplay with friends\nJoin us at play.example.com'
    };
}

function getAiMockData() {
    return {
        label: (document.getElementById('cloud-ai-label') || {}).value || 'DeepSeek',
        status: 'OK',
        balance: 1245.80
    };
}

function getPreviewStyle() {
    const el = document.getElementById('mc-preview-style');
    return el ? el.value : 'classic';
}

function getAiPreviewStyle() {
    const el = document.getElementById('ai-preview-style');
    return el ? el.value : 'classic';
}

function getMcShowPlayers() {
    const el = document.getElementById('mc-show-players');
    return el ? el.checked : false;
}

function formatTimestamp() {
    const d = new Date();
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0');
}

// ===== 通用元素渲染（根据 layout） =====
function renderMcElements(R, mc, showPlayers, layout, darkMode) {
    const BLACK = 0x00, WHITE = 0x01, BLUE = 0x05;
    const fgTitle = darkMode ? BLACK : WHITE;
    const fgPage = darkMode ? BLACK : WHITE;
    const fgBadge = darkMode ? BLACK : WHITE;
    const statusColor = mc.status === 'ONLINE' ? 0x06 : (mc.status === 'WAITING' ? 0x02 : 0x03);
    const countText = mc.players_online + ' / ' + mc.players_max;

    if (layout.title && layout.title.visible) {
        R.drawText(layout.title.x, layout.title.y, 'MC SERVER', fgTitle, null, layout.title.scale);
    }
    if (layout.pageNum && layout.pageNum.visible) {
        R.drawText(layout.pageNum.x, layout.pageNum.y, '1/2', fgPage, null, layout.pageNum.scale);
    }
    if (layout.statusBadge && layout.statusBadge.visible) {
        R.drawBadge(layout.statusBadge.x, layout.statusBadge.y, mc.status, fgBadge, statusColor);
    }
    if (layout.playerCount && layout.playerCount.visible) {
        R.drawTextCenter(layout.playerCount.x, layout.playerCount.y, countText, darkMode ? 0x02 : BLACK, null, layout.playerCount.scale);
    }
    if (layout.host && layout.host.visible) {
        R.drawTextCenter(layout.host.x, layout.host.y, mc.host, BLUE, null, layout.host.scale);
    }
    if (layout.version && layout.version.visible) {
        R.drawTextCenter(layout.version.x, layout.version.y, 'v' + mc.version, darkMode ? WHITE : BLACK, null, layout.version.scale);
    }
    if (layout.divider && layout.divider.visible) {
        R.drawHline(layout.divider.x, layout.divider.y, layout.divider.w, darkMode ? 0x05 : BLACK);
    }
    if (layout.timestamp && layout.timestamp.visible) {
        R.drawText(layout.timestamp.x, layout.timestamp.y, formatTimestamp(), darkMode ? WHITE : BLACK, null, layout.timestamp.scale);
    }
    if (showPlayers && layout.avatars && layout.avatars.visible) {
        drawPlayerAvatars(R, layout.avatars.x, layout.avatars.y, layout.avatars.size, layout.avatars.gap, darkMode);
    }
}

function renderAiElements(R, ai, layout, darkMode) {
    const BLACK = 0x00, WHITE = 0x01;
    const fgTitle = darkMode ? BLACK : WHITE;
    const fgPage = darkMode ? BLACK : WHITE;
    const fgBadge = darkMode ? BLACK : WHITE;
    const balanceText = ai.balance.toFixed(2);

    if (layout.title && layout.title.visible) {
        R.drawText(layout.title.x, layout.title.y, 'AI - ' + ai.label, fgTitle, null, layout.title.scale);
    }
    if (layout.pageNum && layout.pageNum.visible) {
        R.drawText(layout.pageNum.x, layout.pageNum.y, '2/2', fgPage, null, layout.pageNum.scale);
    }
    if (layout.statusBadge && layout.statusBadge.visible) {
        R.drawBadge(layout.statusBadge.x, layout.statusBadge.y, ai.status, fgBadge, 0x06);
    }
    if (layout.balance && layout.balance.visible) {
        R.drawTextCenter(layout.balance.x, layout.balance.y, balanceText, darkMode ? 0x02 : BLACK, null, layout.balance.scale);
    }
    if (layout.divider && layout.divider.visible) {
        R.drawHline(layout.divider.x, layout.divider.y, layout.divider.w, darkMode ? 0x05 : BLACK);
    }
    if (layout.timestamp && layout.timestamp.visible) {
        R.drawText(layout.timestamp.x, layout.timestamp.y, formatTimestamp(), darkMode ? WHITE : BLACK, null, layout.timestamp.scale);
    }
}

// ===== MC 预览渲染 =====
async function mcPreviewRender() {
    if (!EpdRenderer.init('mc-preview-canvas')) return;
    const mc = getMcMockData();
    const showPlayers = getMcShowPlayers();
    const R = EpdRenderer;

    if (showPlayers) {
        // 获取所有玩家的皮肤头像
        const headSize = 120;
        const skinHeads = {};
        const playerCount = Math.min(mc.players_online, MC_SAMPLE_PLAYERS.length);
        // 尝试获取皮肤（后台加载，不阻塞）
        for (let i = 0; i < playerCount; i++) {
            const username = MC_SAMPLE_PLAYERS[i];
            const head = await getSkinHeadForPlayer(username, headSize);
            if (head) skinHeads[username] = head;
        }

        // 绘制背景图（如果有）
        const bgCanvas = await getProcessedBg('mc');
        if (bgCanvas) {
            R.ctx.drawImage(bgCanvas, 0, 0);
            R.ctx.globalAlpha = 0.45;
            R.ctx.fillStyle = PALETTE[0x01];
            R.ctx.fillRect(0, 0, 792, 528);
            R.ctx.globalAlpha = 1.0;
        } else {
            R.clear(0x01);
        }
        mcPreviewAvatarGrid(R, mc, skinHeads, !!bgCanvas);
    } else {
        // 绘制背景图（如果有）
        const bgCanvas = await getProcessedBg('mc');
        if (bgCanvas) {
            R.ctx.drawImage(bgCanvas, 0, 0);
            R.ctx.globalAlpha = 0.45;
            R.ctx.fillStyle = PALETTE[0x01];
            R.ctx.fillRect(0, 0, 792, 528);
            R.ctx.globalAlpha = 1.0;
        } else {
            R.clear(0x01);
        }
        mcPreviewModern(R, mc, showPlayers);
    }
}

function mcPreviewGradient(R, mc, showPlayers, layout) {
    R.clear(0x01);
    if (layout.headerBar && layout.headerBar.visible) {
        const hx = layout.headerBar.x || 0;
        for (let i = 0; i < 792; i++) {
            const t = i / 792;
            let frac, c1, c2;
            if (t < 0.5) { c1 = PALETTE[0x00]; c2 = PALETTE[0x05]; frac = t / 0.5; }
            else { c1 = PALETTE[0x05]; c2 = PALETTE[0x00]; frac = (t - 0.5) / 0.5; }
            const r = Math.round(parseInt(c1.slice(1,3),16)*(1-frac) + parseInt(c2.slice(1,3),16)*frac);
            const g = Math.round(parseInt(c1.slice(3,5),16)*(1-frac) + parseInt(c2.slice(3,5),16)*frac);
            const b = Math.round(parseInt(c1.slice(5,7),16)*(1-frac) + parseInt(c2.slice(5,7),16)*frac);
            R.fillRect(hx + i, layout.headerBar.y, 1, layout.headerBar.h, 'rgb('+r+','+g+','+b+')');
        }
        R.drawHline(hx, layout.headerBar.y + layout.headerBar.h, 792, 0x02);
    }
    renderMcElements(R, mc, showPlayers, layout, false);
}

function applyLayoutOffset(layout, ox, oy) {
    const result = {};
    for (const key in layout) {
        result[key] = Object.assign({}, layout[key]);
        if (layout[key].x !== undefined) result[key].x = layout[key].x + ox;
        if (layout[key].y !== undefined) result[key].y = layout[key].y + oy;
    }
    return result;
}

function mcPreviewCard(R, mc, showPlayers, layout) {
    R.clear(0x01);
    const cx = 30, cy = 30, cw = 732, ch = 468;
    R.drawRect(cx, cy, cw, ch, 0x00);
    const cardLayout = applyLayoutOffset(layout, cx - (layout.headerBar.x || 0), cy - (layout.headerBar.y || 0));
    if (cardLayout.headerBar && cardLayout.headerBar.visible) {
        R.fillRect(cardLayout.headerBar.x, cardLayout.headerBar.y, cw, cardLayout.headerBar.h, 0x00);
    }
    renderMcElements(R, mc, showPlayers, cardLayout, false);
}

function mcPreviewPixel(R, mc, showPlayers, layout) {
    R.clear(0x01);
    const bw = 2;
    for (let i = 0; i < 792; i += bw * 2) {
        const c1 = ((i / (bw * 2)) & 1) ? 0x02 : 0x00;
        const c2 = ((i / (bw * 2)) & 1) ? 0x00 : 0x02;
        R.fillRect(i, 0, bw, bw, c1); R.fillRect(i + bw, 0, bw, bw, c2);
        R.fillRect(i, 528 - bw, bw, bw, c2); R.fillRect(i + bw, 528 - bw, bw, bw, c1);
    }
    for (let j = 0; j < 528; j += bw * 2) {
        const c1 = ((j / (bw * 2)) & 1) ? 0x02 : 0x00;
        const c2 = ((j / (bw * 2)) & 1) ? 0x00 : 0x02;
        R.fillRect(0, j, bw, bw, c1); R.fillRect(0, j + bw, bw, bw, c2);
        R.fillRect(792 - bw, j, bw, bw, c2); R.fillRect(792 - bw, j + bw, bw, bw, c1);
    }
    const pxLayout = applyLayoutOffset(layout, 10, 0);
    if (pxLayout.headerBar && pxLayout.headerBar.visible) {
        R.fillRect(pxLayout.headerBar.x, pxLayout.headerBar.y, 772, pxLayout.headerBar.h, 0x00);
    }
    renderMcElements(R, mc, showPlayers, pxLayout, false);
}

function mcPreviewDark(R, mc, showPlayers, layout) {
    R.clear(0x00);
    if (layout.headerBar && layout.headerBar.visible) {
        R.fillRect(layout.headerBar.x || 0, layout.headerBar.y, 792, layout.headerBar.h, 0x01);
    }
    renderMcElements(R, mc, showPlayers, layout, true);
}

// ===== MC 优雅仪表盘风格 =====
function mcPreviewElegant(R, mc, showPlayers, layout) {
    const BLACK = 0x00, WHITE = 0x01, YELLOW = 0x02, RED = 0x03, BLUE = 0x05, GREEN = 0x06;

    // 1. 纸张底色
    R.clear(WHITE);

    // 2. 左上角品牌色块 + 顶部蓝色装饰线
    R.fillRect(0, 0, 792, 4, BLUE);      // 顶边：蓝色粗线
    R.fillRect(0, 8, 10, 60, GREEN);    // 左竖装饰：绿色
    R.fillRect(0, 520, 792, 8, YELLOW); // 底边：黄色

    // 3. 右上角页脚页码
    R.drawTextRight(776, 18, '1 / 2', BLACK, null, 2);
    R.fillRect(700, 42, 76, 2, BLUE);   // 页码下方蓝色短划线

    // 4. 标题
    R.drawText(24, 18, 'MC  SERVER', BLACK, null, 4);
    R.drawText(24, 50, 'MINECRAFT  SERVICE  STATUS', BLUE, null, 1);

    // 5. 状态徽章（绿色圆角大标签）
    const statusColor = mc.status === 'ONLINE' ? GREEN : (mc.status === 'WAITING' ? YELLOW : RED);
    R.fillRoundRect(570, 16, 120, 34, 8, statusColor);
    R.drawTextCenter(630, 25, mc.status, WHITE, null, 2);
    // 小圆圈指示
    R.fillCircle(588, 33, 4, WHITE);

    // 6. 中央核心数据：玩家在线数
    // 左侧绿色竖条
    R.fillRect(90, 120, 10, 180, GREEN);
    // 玩家数大标题
    const countOnline = String(mc.players_online);
    const countMax = ' / ' + mc.players_max;
    // 先测宽度，把在线数字+大字号+ / +小字号 放一起
    R.drawText(130, 130, countOnline, BLACK, null, 18);
    const bigW = R.measureText(countOnline, 18);
    R.drawText(130 + bigW + 6, 190, countMax, BLUE, null, 5);

    // "PLAYERS ONLINE" 标签
    R.drawText(130, 300, '◆  PLAYERS  ONLINE', GREEN, null, 2);

    // 7. 右侧小卡：主机信息 + 版本
    // 主机卡
    R.fillRoundRect(480, 120, 260, 50, 6, BLUE);
    R.drawText(496, 132, 'HOST', WHITE, null, 2);
    R.drawRect(480, 170, 260, 60, BLUE);
    R.drawTextCenter(610, 190, mc.host, BLACK, null, 2);

    // 版本卡
    R.fillRoundRect(480, 250, 260, 50, 6, YELLOW);
    R.drawText(496, 262, 'VERSION', BLACK, null, 2);
    R.drawRect(480, 300, 260, 60, YELLOW);
    R.drawTextCenter(610, 320, 'v' + mc.version, BLACK, null, 2);

    // 8. 中部装饰分割：三色点缀圆点
    const decY = 395;
    R.fillCircle(396, decY, 6, BLUE);
    R.fillCircle(360, decY, 4, YELLOW);
    R.fillCircle(432, decY, 4, GREEN);
    R.fillCircle(324, decY, 3, RED);
    R.fillCircle(468, decY, 3, BLACK);
    R.drawHline(20, decY, 280, BLUE);
    R.drawHline(492, decY, 280, BLUE);

    // 9. 底部玩家头像 + 时间戳
    if (showPlayers) {
        drawPlayerAvatars(R, 24, 418, 44, 10, false);
        R.drawTextRight(776, 430, formatTimestamp(), BLUE, null, 2);
    } else {
        R.drawText(24, 430, '◆  ' + formatTimestamp(), BLACK, null, 2);
        R.drawTextRight(776, 430, 'FrameFilm  Pro', BLUE, null, 2);
    }

    // 10. 右下角品牌标签
    R.fillRect(730, 490, 62, 24, BLACK);
    R.drawText(740, 498, 'Pro', WHITE, null, 2);
}

// ===== AI 优雅仪表盘风格 =====
function aiPreviewElegant(R, ai, layout) {
    const BLACK = 0x00, WHITE = 0x01, YELLOW = 0x02, RED = 0x03, BLUE = 0x05, GREEN = 0x06;

    R.clear(WHITE);

    // -- 边饰：上下绿 --
    R.fillRect(0, 0, 792, 4, GREEN);
    R.fillRect(0, 520, 792, 8, GREEN);

    // -- 标题胶囊 --
    R.fillRoundRect(20, 18, 460, 42, 8, GREEN);
    R.drawText(36, 28, 'AI  ◆  ' + ai.label.toUpperCase(), WHITE, null, 3);

    // -- 状态徽章 --
    R.fillRoundRect(620, 20, 100, 30, 6, BLUE);
    R.fillCircle(636, 35, 3, WHITE);
    R.drawTextCenter(676, 28, ai.status, WHITE, null, 2);

    // -- 页码 --
    R.drawTextRight(776, 58, '2 / 2', BLACK, null, 2);

    // -- 核心余额（居中） --
    const balanceInt = Math.floor(ai.balance);
    const balanceDec = '.' + (ai.balance - balanceInt).toFixed(2).slice(2);
    const intStr = balanceInt.toLocaleString();

    const symW = R.measureText('¥', 6);
    const intW = R.measureText(intStr, 14);
    const decW = R.measureText(balanceDec, 6);
    const totalW = symW + 8 + intW + 6 + decW;
    const sx = Math.floor((792 - totalW) / 2);

    // 左侧蓝色竖条
    R.fillRect(sx - 26, 110, 6, 150, BLUE);

    // ¥ 符号（蓝色，底部对齐整数）
    const intBottom = 115 + 14 * 6.5;   // 整数底部 = 206
    const smY = Math.round(intBottom - 6 * 6.5); // 小字 y = 167
    R.drawText(sx, smY, '¥', BLUE, null, 6);
    // 整数部分（大黑字）
    R.drawText(sx + symW + 8, 115, intStr, BLACK, null, 14);
    // 小数部分（绿色，底部对齐整数）
    R.drawText(sx + symW + 8 + intW + 6, smY, balanceDec, GREEN, null, 6);

    // 余额标签
    R.drawTextCenter(396, 275, '◆  TOKEN  BALANCE', GREEN, null, 2);

    // -- 进度条 --
    const barX = 100, barW = 592, barY = 315;
    const ratio = Math.min(1, ai.balance / 5000);
    R.fillRoundRect(barX, barY, barW, 14, 3, BLACK);
    R.fillRoundRect(barX, barY, Math.max(14, Math.floor(barW * ratio)), 14, 3, GREEN);
    if (ratio > 0.02) {
        R.fillCircle(barX + Math.floor(barW * ratio), barY + 7, 10, YELLOW);
    }
    R.drawText(barX, barY + 22, '¥0', BLACK, null, 1);
    R.drawTextRight(barX + barW, barY + 22, '¥5,000', BLACK, null, 1);

    // -- 状态提示 --
    let tipColor = GREEN, tipText = '◆  BALANCE  OK';
    if (ai.balance < 100) { tipColor = RED; tipText = '!  LOW  BALANCE'; }
    else if (ai.balance < 500) { tipColor = YELLOW; tipText = '△  MEDIUM  BALANCE'; }
    R.drawTextCenter(396, 365, tipText, tipColor, null, 2);

    // -- 底部分割 --
    const decY2 = 415;
    R.drawHline(60, decY2, 300, GREEN);
    R.drawHline(432, decY2, 300, GREEN);
    R.fillCircle(396, decY2, 5, GREEN);
    R.fillCircle(366, decY2, 3, YELLOW);
    R.fillCircle(426, decY2, 3, BLUE);

    // -- 底部信息 --
    R.drawText(60, 445, formatTimestamp(), BLACK, null, 2);
    R.drawTextRight(732, 445, ai.label, BLUE, null, 2);

    // 品牌
    R.fillRect(720, 488, 60, 22, GREEN);
    R.drawText(730, 494, 'Pro', WHITE, null, 2);
}

function drawPlayerAvatars(R, x, y, size, gap, darkMode) {
    const maxShow = 8;
    const count = Math.min(MC_SAMPLE_PLAYERS.length, maxShow);
    for (let i = 0; i < count; i++) {
        const ax = x + i * (size + gap);
        const initial = MC_SAMPLE_PLAYERS[i].charAt(0).toUpperCase();
        const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
        R.drawAvatar(ax, y, size, initial, color);
    }
    if (MC_SAMPLE_PLAYERS.length > maxShow) {
        const extra = '+' + (MC_SAMPLE_PLAYERS.length - maxShow);
        const txtColor = darkMode ? 0x01 : 0x00;
        R.drawText(x + count * (size + gap), y + size / 2 - 8, extra, txtColor, null, 2);
    }
}

// ===== AI 预览渲染 =====
async function aiPreviewRender() {
    if (!EpdRenderer.init('ai-preview-canvas')) return;
    const ai = getAiMockData();
    const R = EpdRenderer;

    // 绘制背景图（如果有）
    const bgCanvas = await getProcessedBg('ai');
    if (bgCanvas) {
        R.ctx.drawImage(bgCanvas, 0, 0);
        R.ctx.globalAlpha = 0.45;
        R.ctx.fillStyle = PALETTE[0x01];
        R.ctx.fillRect(0, 0, 792, 528);
        R.ctx.globalAlpha = 1.0;
    } else {
        R.clear(0x01);
    }

    aiPreviewModern(R, ai);
}

function aiPreviewClassic(R, ai, layout) {
    R.clear(0x01);
    if (layout.headerBar && layout.headerBar.visible) {
        R.fillRect(layout.headerBar.x || 0, layout.headerBar.y, 792, layout.headerBar.h, 0x00);
    }
    renderAiElements(R, ai, layout, false);
}

function aiPreviewGradient(R, ai, layout) {
    R.clear(0x01);
    if (layout.headerBar && layout.headerBar.visible) {
        const hx = layout.headerBar.x || 0;
        for (let i = 0; i < 792; i++) {
            const t = i / 792;
            let c1, c2, frac;
            if (t < 0.5) { c1 = PALETTE[0x00]; c2 = PALETTE[0x05]; frac = t / 0.5; }
            else { c1 = PALETTE[0x05]; c2 = PALETTE[0x00]; frac = (t - 0.5) / 0.5; }
            const r = Math.round(parseInt(c1.slice(1,3),16)*(1-frac) + parseInt(c2.slice(1,3),16)*frac);
            const g = Math.round(parseInt(c1.slice(3,5),16)*(1-frac) + parseInt(c2.slice(3,5),16)*frac);
            const b = Math.round(parseInt(c1.slice(5,7),16)*(1-frac) + parseInt(c2.slice(5,7),16)*frac);
            R.fillRect(hx + i, layout.headerBar.y, 1, layout.headerBar.h, 'rgb('+r+','+g+','+b+')');
        }
        R.drawHline(hx, layout.headerBar.y + layout.headerBar.h, 792, 0x02);
    }
    renderAiElements(R, ai, layout, false);
}

function aiPreviewCard(R, ai, layout) {
    R.clear(0x01);
    const cx = 30, cy = 30, cw = 732, ch = 468;
    R.drawRect(cx, cy, cw, ch, 0x00);
    const cardLayout = applyLayoutOffset(layout, cx - (layout.headerBar.x || 0), cy - (layout.headerBar.y || 0));
    if (cardLayout.headerBar && cardLayout.headerBar.visible) {
        R.fillRect(cardLayout.headerBar.x, cardLayout.headerBar.y, cw, cardLayout.headerBar.h, 0x00);
    }
    renderAiElements(R, ai, cardLayout, false);
}

function aiPreviewPixel(R, ai, layout) {
    R.clear(0x01);
    const bw = 2;
    for (let i = 0; i < 792; i += bw * 2) {
        const c1 = ((i / (bw * 2)) & 1) ? 0x02 : 0x00;
        const c2 = ((i / (bw * 2)) & 1) ? 0x00 : 0x02;
        R.fillRect(i, 0, bw, bw, c1); R.fillRect(i + bw, 0, bw, bw, c2);
        R.fillRect(i, 528 - bw, bw, bw, c2); R.fillRect(i + bw, 528 - bw, bw, bw, c1);
    }
    for (let j = 0; j < 528; j += bw * 2) {
        const c1 = ((j / (bw * 2)) & 1) ? 0x02 : 0x00;
        const c2 = ((j / (bw * 2)) & 1) ? 0x00 : 0x02;
        R.fillRect(0, j, bw, bw, c1); R.fillRect(0, j + bw, bw, bw, c2);
        R.fillRect(792 - bw, j, bw, bw, c2); R.fillRect(792 - bw, j + bw, bw, bw, c1);
    }
    const pxLayout = applyLayoutOffset(layout, 10, 0);
    if (pxLayout.headerBar && pxLayout.headerBar.visible) {
        R.fillRect(pxLayout.headerBar.x, pxLayout.headerBar.y, 772, pxLayout.headerBar.h, 0x00);
    }
    renderAiElements(R, ai, pxLayout, false);
}

function aiPreviewDark(R, ai, layout) {
    R.clear(0x00);
    if (layout.headerBar && layout.headerBar.visible) {
        R.fillRect(layout.headerBar.x || 0, layout.headerBar.y, 792, layout.headerBar.h, 0x01);
    }
    renderAiElements(R, ai, layout, true);
}

// ===== 设备直连 BLE 读写 =====
function loadDeviceInfoConfig() {
    if (!device) return;
    queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_ENABLE_GET, null))
        .then(() => queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_REFRESH_MIN_GET, null)))
        .then(() => queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_MC_HOST_GET, null)))
        .then(() => queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_MC_PORT_GET, null)))
        .then(() => queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_MC_URL_GET, null)))
        .then(() => queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_AI_URL_GET, null)))
        .then(() => queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_AI_TOKEN_GET, null)))
        .then(() => queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_SRV_URL_GET, null)))
        .then(() => queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_PAGE_GET, null)))
        .catch(err => console.warn('read info config from device failed', err));
}

function toggleInfoSwitch() {
    const v = document.getElementById('info-enable-switch').checked ? 1 : 0;
    queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_ENABLE, v))
        .then(() => { deviceInfoEnable = v; setInfoStatus(v ? '已开启' : '已关闭'); })
        .catch(err => setInfoStatus('失败: ' + err.message, true));
}

// 下发 MC 服务器 host:port 到设备 (SLP 直连)
function applyInfoMcHost() {
    const host = document.getElementById('info-mc-host-input').value.trim();
    const portVal = parseInt(document.getElementById('info-mc-port-input').value, 10) || 25565;
    if (!host) { setMcStatus('host 为空', true); return; }
    if (host.length > 63) { setMcStatus('host 过长 (>63)', true); return; }
    if (portVal < 1 || portVal > 65535) { setMcStatus('端口范围 1-65535', true); return; }
    /* 先下发 host */
    const hostPkt = buildStringPacket(BLE_FILM_TRANS_CH_CTRL_INFO_MC_HOST, host, 64);
    queueBleCmd(() => sendBlePacket(hostPkt))
        .then(() => {
            deviceInfoMcHost = host;
            /* 再下发 port (uint16 big-endian) */
            const portData = new Uint8Array(2);
            portData[0] = (portVal >> 8) & 0xFF;
            portData[1] = portVal & 0xFF;
            return queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_MC_PORT, portData));
        })
        .then(() => {
            deviceInfoMcPort = portVal;
            setMcStatus('SLP host:port 已下发 (' + host + ':' + portVal + ')');
        })
        .catch(err => setMcStatus('失败: ' + err.message, true));
}

// 下发 MC HTTP API URL 到设备 (可选兜底)
function applyInfoMcUrl() {
    const url = document.getElementById('info-mc-url-input').value.trim();
    if (!url) { setMcStatus('URL 为空 (留空则仅用 SLP)', false); return; }
    if (url.length > 192) { setMcStatus('URL 过长 (>192)', true); return; }
    const pkt = buildStringPacket(BLE_FILM_TRANS_CH_CTRL_INFO_MC_URL, url, 192);
    queueBleCmd(() => sendBlePacket(pkt))
        .then(() => { deviceInfoMcUrl = url; setMcStatus('MC HTTP URL 已下发 (' + url.length + ' 字符)'); })
        .catch(err => setMcStatus('失败: ' + err.message, true));
}

// 下发 AI 余额查询 URL 到设备
function applyInfoAiUrl() {
    const url = document.getElementById('info-ai-url-input').value.trim();
    if (!url) { setAiStatus('URL 为空', true); return; }
    if (url.length > 192) { setAiStatus('URL 过长 (>192)', true); return; }
    const pkt = buildStringPacket(BLE_FILM_TRANS_CH_CTRL_INFO_AI_URL, url, 192);
    queueBleCmd(() => sendBlePacket(pkt))
        .then(() => { deviceInfoAiUrl = url; setAiStatus('AI URL 已下发 (' + url.length + ' 字符)'); })
        .catch(err => setAiStatus('失败: ' + err.message, true));
}

// 下发 AI API Token 到设备
function applyInfoAiToken() {
    const tok = document.getElementById('info-ai-token-input').value.trim();
    if (!tok) { setAiStatus('Token 为空', true); return; }
    if (tok.length > 64) { setAiStatus('Token 过长 (>64)', true); return; }
    const pkt = buildStringPacket(BLE_FILM_TRANS_CH_CTRL_INFO_AI_TOKEN, tok, 64);
    queueBleCmd(() => sendBlePacket(pkt))
        .then(() => { deviceInfoAiToken = tok; setAiStatus('AI Token 已下发 (' + tok.length + ' 字符)'); })
        .catch(err => setAiStatus('失败: ' + err.message, true));
}

// 下发服务器监控 API URL 到设备
function applyInfoSrvUrl() {
    const url = document.getElementById('info-srv-url-input').value.trim();
    if (!url) { setSrvStatus('URL 为空', true); return; }
    if (url.length > 192) { setSrvStatus('URL 过长 (>192)', true); return; }
    const pkt = buildStringPacket(BLE_FILM_TRANS_CH_CTRL_INFO_SRV_URL, url, 192);
    queueBleCmd(() => sendBlePacket(pkt))
        .then(() => { deviceInfoSrvUrl = url; setSrvStatus('SRV URL 已下发 (' + url.length + ' 字符)'); })
        .catch(err => setSrvStatus('失败: ' + err.message, true));
}

function onInfoRefresh() {
    queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_REFRESH, null))
        .then(() => setInfoStatus('已触发刷新, 设备将直接请求 API'))
        .catch(err => setInfoStatus('失败: ' + err.message, true));
}

function updateMcRefreshSlider() {
    const v = parseInt(document.getElementById('mc-refresh-min').value, 10) || 10;
    const el = document.getElementById('mc-refresh-value');
    if (el) el.textContent = v + '分钟';
}

function applyMcRefreshMin() {
    const v = parseInt(document.getElementById('mc-refresh-min').value, 10) || 10;
    const data = new Uint8Array(2);
    data[0] = (v >> 8) & 0xFF; data[1] = v & 0xFF;
    queueBleCmd(() => sendBleCmd(BLE_FILM_TRANS_CH_CTRL_INFO_REFRESH_MIN, data))
        .then(() => { deviceInfoRefreshMin = v; setInfoStatus('刷新间隔: ' + v + ' 分钟'); })
        .catch(err => setInfoStatus('失败: ' + err.message, true));
}

function setInfoStatus(text, isError) {
    const el = document.getElementById('info-status-text');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#D32F2F' : '#4CAF50';
}

function setMcStatus(text, isError) {
    const el = document.getElementById('mc-status-text');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#D32F2F' : '#4CAF50';
}

function setAiStatus(text, isError) {
    const el = document.getElementById('ai-status-text');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#D32F2F' : '#4CAF50';
}

// ===== 设备响应回填 (设备直连) =====
function handleInfoWallResponse(cmdType, data) {
    if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_ENABLE_GET && data.length >= 4) {
        deviceInfoEnable = data[3];
        const sw = document.getElementById('info-enable-switch');
        if (sw) sw.checked = !!deviceInfoEnable;
    } else if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_MC_HOST_GET && data.length > 3) {
        deviceInfoMcHost = bytesToAsciiString(data, 3, data[2]);
        const inp = document.getElementById('info-mc-host-input');
        if (inp) inp.value = deviceInfoMcHost;
        setMcStatus('已读取设备 MC host: ' + deviceInfoMcHost);
    } else if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_MC_PORT_GET && data.length >= 6) {
        deviceInfoMcPort = (data[3] << 8) | data[4];
        const inp = document.getElementById('info-mc-port-input');
        if (inp) inp.value = deviceInfoMcPort;
    } else if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_MC_URL_GET && data.length > 3) {
        deviceInfoMcUrl = bytesToAsciiString(data, 3, data[2]);
        const inp = document.getElementById('info-mc-url-input');
        if (inp) inp.value = deviceInfoMcUrl;
        setMcStatus('已读取设备 MC HTTP URL (' + deviceInfoMcUrl.length + ' 字符)');
    } else if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_AI_URL_GET && data.length > 3) {
        deviceInfoAiUrl = bytesToAsciiString(data, 3, data[2]);
        const inp = document.getElementById('info-ai-url-input');
        if (inp) inp.value = deviceInfoAiUrl;
        setAiStatus('已读取设备 AI URL (' + deviceInfoAiUrl.length + ' 字符)');
    } else if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_AI_TOKEN_GET && data.length > 3) {
        deviceInfoAiToken = bytesToAsciiString(data, 3, data[2]);
        const inp = document.getElementById('info-ai-token-input');
        if (inp) inp.value = deviceInfoAiToken;
        setAiStatus('已读取设备 AI Token (' + deviceInfoAiToken.length + ' 字符)');
    } else if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_SRV_URL_GET && data.length > 3) {
        deviceInfoSrvUrl = bytesToAsciiString(data, 3, data[2]);
        const inp = document.getElementById('info-srv-url-input');
        if (inp) inp.value = deviceInfoSrvUrl;
        setSrvStatus('已读取设备 SRV URL (' + deviceInfoSrvUrl.length + ' 字符)');
    } else if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_REFRESH_MIN_GET && data.length >= 5) {
        deviceInfoRefreshMin = (data[3] << 8) | data[4];
        const mcSlider = document.getElementById('mc-refresh-min');
        if (mcSlider) { mcSlider.value = deviceInfoRefreshMin; updateMcRefreshSlider(); }
    } else if (cmdType === BLE_FILM_TRANS_CH_CTRL_INFO_PAGE_GET && data.length >= 4) {
        deviceInfoPage = data[3];
    }
}

function bytesToAsciiString(data, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
        const c = data[offset + i];
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

function setInfoSectionVisible(visible) {
    const sec = document.getElementById('info-settings-section');
    if (sec) sec.style.display = visible ? 'block' : 'none';
}

// ===== 初始化 =====
function initInfoPage() {
    mcPreviewRender(); aiPreviewRender(); srvPreviewRender();

    const mcHostEl = document.getElementById('info-mc-host-input');
    if (mcHostEl) mcHostEl.addEventListener('input', mcPreviewRender);

    const aiLabelEl = document.getElementById('cloud-ai-label');
    if (aiLabelEl) aiLabelEl.addEventListener('input', aiPreviewRender);

    const srvLabelEl = document.getElementById('cloud-srv-label');
    if (srvLabelEl) srvLabelEl.addEventListener('input', srvPreviewRender);

    const previewStyleEl = document.getElementById('mc-preview-style');
    if (previewStyleEl) previewStyleEl.addEventListener('change', function () {
        mcPreviewRender(); aiPreviewRender();
    });

    const aiStyleEl = document.getElementById('ai-preview-style');
    if (aiStyleEl) aiStyleEl.addEventListener('change', aiPreviewRender);

    const srvStyleEl = document.getElementById('srv-preview-style');
    if (srvStyleEl) srvStyleEl.addEventListener('change', srvPreviewRender);

    const showPlayersEl = document.getElementById('mc-show-players');
    if (showPlayersEl) showPlayersEl.addEventListener('change', mcPreviewRender);

    const mcSlider = document.getElementById('mc-refresh-min');
    if (mcSlider) mcSlider.addEventListener('input', updateMcRefreshSlider);
}

const _origInitBluetooth = window.initBluetooth;
window.initBluetooth = function () {
    if (typeof _origInitBluetooth === 'function') _origInitBluetooth();
    setInfoSectionVisible(true);
    if (device) loadDeviceInfoConfig();
    initInfoPage();
};

// ===== 信息墙子 tab 切换 =====
function switchInfoTab(tabId) {
    document.querySelectorAll('.info-sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.info-sub-content').forEach(c => c.classList.remove('active'));
    const btn = document.querySelector('[data-info-tab="' + tabId + '"]');
    if (btn) btn.classList.add('active');
    const panel = document.getElementById(tabId);
    if (panel) panel.classList.add('active');
    if (tabId === 'mc-tab') mcPreviewRender();
    else if (tabId === 'ai-tab') aiPreviewRender();
    else if (tabId === 'srv-tab') srvPreviewRender();
}

// ===== 服务器监控 mock 数据 =====
function getSrvMockData() {
    return {
        label: 'My Server',
        status: 'ONLINE',
        cpu: 42,
        mem: 68,
        disk: 55,
        netUp: 1.2,
        netDown: 8.5,
        uptime: '14d 6h',
        cpuCores: 4,
        memTotal: 16
    };
}

function getSrvShowCores() {
    const el = document.getElementById('srv-show-cores');
    return el ? el.checked : true;
}

// ===== 服务器监控渲染 =====
async function srvPreviewRender() {
    if (!EpdRenderer.init('srv-preview-canvas')) return;
    const srv = getSrvMockData();
    const R = EpdRenderer;

    // 绘制背景图（如果有）
    const bgCanvas = await getProcessedBg('srv');
    if (bgCanvas) {
        R.ctx.drawImage(bgCanvas, 0, 0);
        R.ctx.globalAlpha = 0.45;
        R.ctx.fillStyle = PALETTE[0x01];
        R.ctx.fillRect(0, 0, 792, 528);
        R.ctx.globalAlpha = 1.0;
    } else {
        R.clear(0x01);
    }

    srvPreviewModern(R, srv);
}

// ===== 服务器监控 - 优雅仪表盘 =====
function srvPreviewElegant(R, srv) {
    const BLACK = 0x00, WHITE = 0x01, YELLOW = 0x02, RED = 0x03, BLUE = 0x05, GREEN = 0x06;

    R.clear(WHITE);

    // -- 边饰：红色顶底（服务器监控专属配色） --
    R.fillRect(0, 0, 792, 4, RED);
    R.fillRect(0, 520, 792, 8, RED);

    // -- 标题胶囊（蓝色） --
    R.fillRoundRect(20, 18, 460, 42, 8, BLUE);
    R.drawText(36, 28, 'SRV  ◆  ' + srv.label.toUpperCase(), WHITE, null, 3);

    // -- 状态徽章 --
    R.fillRoundRect(620, 20, 100, 30, 6, GREEN);
    R.fillCircle(636, 35, 3, WHITE);
    R.drawTextCenter(676, 28, srv.status, WHITE, null, 2);

    // -- 页码 --
    R.drawTextRight(776, 58, '3 / 3', BLACK, null, 2);

    // -- 6 个指标卡（2列×3行） --
    const cards = [
        { label: 'CPU',    value: srv.cpu + '%',           ratio: srv.cpu / 100,       color: BLUE,   x: 30,  y: 90 },
        { label: 'MEM',    value: srv.mem + '%',           ratio: srv.mem / 100,       color: GREEN,  x: 410, y: 90 },
        { label: 'DISK',   value: srv.disk + '%',          ratio: srv.disk / 100,      color: YELLOW, x: 30,  y: 235 },
        { label: 'NET UP', value: srv.netUp + ' MB/s',     ratio: Math.min(1, srv.netUp / 10),  color: RED,    x: 410, y: 235 },
        { label: 'NET DL', value: srv.netDown + ' MB/s',   ratio: Math.min(1, srv.netDown / 20), color: BLUE,   x: 30,  y: 380 },
        { label: 'UPTIME', value: srv.uptime,              ratio: 0,                   color: GREEN,  x: 410, y: 380 }
    ];

    cards.forEach(function(c) {
        const cw = 352, ch = 120;
        // 卡片外框
        R.fillRoundRect(c.x, c.y, cw, 30, 5, c.color);
        R.drawText(c.x + 12, c.y + 8, c.label, WHITE, null, 2);
        // 值
        R.drawText(c.x + 12, c.y + 42, c.value, BLACK, null, 4);
        // 进度条（除 UPTIME 外）
        if (c.ratio > 0) {
            const barX = c.x + 12, barY = c.y + 92, barW = cw - 24;
            R.fillRoundRect(barX, barY, barW, 12, 3, BLACK);
            const fillW = Math.max(12, Math.floor(barW * c.ratio));
            // 颜色根据值变化
            var barColor = c.color;
            if (c.ratio > 0.85) barColor = RED;
            else if (c.ratio > 0.7) barColor = YELLOW;
            R.fillRoundRect(barX, barY, fillW, 12, 3, barColor);
        }
    });

    // 品牌
    R.fillRect(720, 488, 60, 22, RED);
    R.drawText(730, 494, 'Pro', WHITE, null, 2);
}

// ===== 服务器监控 - 经典黑白 =====
function srvPreviewClassic(R, srv) {
    R.clear(0x01);
    R.fillRect(0, 0, 792, 60, 0x00);
    R.drawText(20, 18, 'SRV - ' + srv.label, 0x01, null, 3);
    R.drawText(740, 22, '3/3', 0x01, null, 2);
    R.drawBadge(20, 75, srv.status, 0x01, 0x06);

    var rows = [
        { l: 'CPU',       v: srv.cpu + '%' },
        { l: 'MEMORY',    v: srv.mem + '%' },
        { l: 'DISK',      v: srv.disk + '%' },
        { l: 'NET UP',    v: srv.netUp + ' MB/s' },
        { l: 'NET DOWN',  v: srv.netDown + ' MB/s' },
        { l: 'UPTIME',    v: srv.uptime }
    ];
    rows.forEach(function(r, i) {
        var y = 110 + i * 60;
        R.drawText(30, y, r.l, 0x00, null, 2);
        R.drawTextRight(762, y, r.v, 0x05, null, 2);
        R.drawHline(30, y + 28, 732, 0x00);
    });
}

// ===== 服务器监控 - 深色主题 =====
function srvPreviewDark(R, srv) {
    R.clear(0x00);
    R.fillRect(0, 0, 792, 60, 0x01);
    R.drawText(20, 18, 'SRV - ' + srv.label, 0x00, null, 3);
    R.drawText(740, 22, '3/3', 0x00, null, 2);
    R.drawBadge(20, 75, srv.status, 0x01, 0x06);

    var rows = [
        { l: 'CPU',       v: srv.cpu + '%',        c: 0x05 },
        { l: 'MEMORY',    v: srv.mem + '%',        c: 0x06 },
        { l: 'DISK',      v: srv.disk + '%',       c: 0x02 },
        { l: 'NET UP',    v: srv.netUp + ' MB/s',  c: 0x03 },
        { l: 'NET DOWN',  v: srv.netDown + ' MB/s', c: 0x05 },
        { l: 'UPTIME',    v: srv.uptime,           c: 0x06 }
    ];
    rows.forEach(function(r, i) {
        var y = 110 + i * 60;
        R.drawText(30, y, r.l, 0x01, null, 2);
        R.drawTextRight(762, y, r.v, r.c, null, 2);
        R.drawHline(30, y + 28, 732, 0x05);
    });
}

// ===== 现代化风格（背景图 + 极简设计） =====
function mcPreviewAvatarGrid(R, mc, skinHeads, hasBg) {
    const BLACK = 0x00, WHITE = 0x01, YELLOW = 0x02, RED = 0x03, BLUE = 0x05, GREEN = 0x06;
    const totalW = 792, totalH = 528;
    const headerH = 56;
    const footerH = 28;
    const mainH = totalH - headerH - footerH;
    const footerY = headerH + mainH;
    const playerCount = Math.min(mc.players_online, MC_SAMPLE_PLAYERS.length);
    const count = Math.max(1, playerCount);

    // 头部
    if (!hasBg) R.clear(WHITE);
    R.fillRect(0, 0, totalW, headerH, GREEN);
    R.fillRect(0, footerY, totalW, footerH, YELLOW);
    // 状态灯
    const sc = mc.status === 'ONLINE' ? YELLOW : RED;
    R.fillCircle(760, 20, 10, sc);
    R.fillCircle(760, 20, 4, BLACK);
    // 标题 + 玩家数
    R.drawText(20, 8, 'MINECRAFT', WHITE, null, 3);
    R.drawText(20, 34, String(playerCount) + '/' + String(mc.players_max) + ' ONLINE', WHITE, null, 1.5);
    // 状态徽章
    R.fillRoundRect(640, 6, 90, 22, 4, WHITE);
    R.drawText(655, 10, mc.status, BLACK, null, 1.2);

    // 固定 5×3 网格布局（最大15人）
    const cols = 5, rows = 3;
    const padX = 20, padY = 16;
    const gapX = 16, gapY = 12;
    const avatarW = Math.floor((totalW - padX * 2 - gapX * (cols - 1)) / cols);
    const avatarH = Math.floor((mainH - padY * 2 - gapY * (rows - 1)) / rows);
    const avatarSize = Math.min(avatarW, avatarH - 20); // 留20px给名字
    const labelH = 18;

    // 居中网格
    const totalGridW = cols * avatarSize + (cols - 1) * gapX;
    const offsetX = Math.floor((totalW - totalGridW) / 2);
    const offsetY = headerH + padY;

    // 绘制每个玩家
    for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = offsetX + col * (avatarSize + gapX);
        const y = offsetY + row * (avatarSize + labelH + gapY);
        const username = MC_SAMPLE_PLAYERS[i];

        // 卡片边框
        R.fillRoundRect(x, y, avatarSize, avatarSize + labelH, 4, BLACK);
        // 头像背景
        R.fillRoundRect(x + 2, y + 2, avatarSize - 4, avatarSize - 4, 3, WHITE);

        // 皮肤头像或字母头像
        const skinHead = skinHeads[username];
        if (skinHead) {
            R.drawCanvas(skinHead, x + 2, y + 2, avatarSize - 4, avatarSize - 4);
        } else {
            const initial = username.charAt(0).toUpperCase();
            const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
            R.drawAvatar(x + 2, y + 2, avatarSize - 4, initial, color);
        }

        // 玩家名字（截断）
        R.fillRoundRect(x + 2, y + avatarSize, avatarSize - 4, labelH - 2, 0, WHITE);
        const displayName = username.length > 8 ? username.substring(0, 7) + '..' : username;
        R.drawText(x + 4, y + avatarSize + 2, displayName, BLACK, null, 1);
    }

    // 底部
    R.drawText(20, footerY + 6, formatTimestamp(), BLACK, null, 1);
    R.drawTextRight(772, footerY + 6, 'FrameFilm Pro', BLUE, null, 1);
}

function mcPreviewModern(R, mc, showPlayers) {
    const BLACK = 0x00, WHITE = 0x01, YELLOW = 0x02, RED = 0x03, BLUE = 0x05, GREEN = 0x06;
    R.clear(WHITE);
    // 装饰竖条
    R.fillRect(0, 0, 6, 528, GREEN);
    R.fillRect(0, 524, 792, 4, YELLOW);

    // === 头部区域 ===
    const sc = mc.status === 'ONLINE' ? GREEN : (mc.status === 'WAITING' ? YELLOW : RED);
    // 状态灯
    R.fillCircle(772, 20, 8, sc);
    R.fillCircle(772, 20, 3, WHITE);
    // 页码
    R.drawTextRight(772, 34, '1/3', BLACK, null, 1);
    // 主标题
    R.drawText(24, 28, 'MC', BLACK, null, 5);
    R.drawText(24, 60, 'MINECRAFT SERVER', BLUE, null, 1.5);
    // 状态徽章
    R.drawBadge(682, 46, mc.status, WHITE, sc);
    // 右上角在线人数
    R.fillRoundRect(580, 6, 90, 40, 6, GREEN);
    R.drawText(588, 10, 'ONLINE', WHITE, null, 1);
    R.drawText(588, 24, String(mc.players_online) + '/' + String(mc.players_max), WHITE, null, 1.8);

    // === 左侧：服务器图标区域 ===
    const iconX = 30, iconY = 100, iconSize = 160;
    // 图标背景框
    R.fillRoundRect(iconX, iconY, iconSize, iconSize, 8, BLACK);
    R.fillRoundRect(iconX + 4, iconY + 4, iconSize - 8, iconSize - 8, 6, WHITE);
    // 服务器图标（如果有）或默认方块图标
    if (mc.icon) {
        R.drawCanvas(mc.icon, iconX + 4, iconY + 4, iconSize - 8, iconSize - 8);
    } else {
        // 默认 MC 方块图标
        const blockSize = 32;
        for (let by = 0; by < 4; by++) {
            for (let bx = 0; bx < 4; bx++) {
                const colors = [GREEN, BLUE, YELLOW, RED];
                R.fillRect(iconX + 8 + bx * 38, iconY + 8 + by * 38, 36, 36, colors[(bx + by) % 4]);
            }
        }
        R.drawText(iconX + 20, iconY + 70, 'MC', WHITE, null, 6);
    }
    // 服务器名称（图标下方）
    R.drawText(iconX + 4, iconY + iconSize + 8, mc.name || 'Server', BLACK, null, 2);
    R.drawText(iconX + 4, iconY + iconSize + 28, mc.host, BLUE, null, 1.2);

    // === 右侧：服务器信息卡片 ===
    const cardX = 210, cardW = 552;
    // 版本
    R.fillRoundRect(cardX, iconY, cardW, 48, 6, YELLOW);
    R.drawText(cardX + 12, iconY + 8, 'VERSION', BLACK, null, 1.2);
    R.drawText(cardX + 12, iconY + 26, 'v' + mc.version, BLACK, null, 2);
    // 状态
    R.fillRoundRect(cardX, iconY + 56, cardW, 48, 6, BLACK);
    R.drawText(cardX + 12, iconY + 64, 'STATUS', WHITE, null, 1.2);
    R.drawText(cardX + 12, iconY + 82, mc.status === 'ONLINE' ? '◆ Online - ' + mc.players_online + ' players' : '◇ Offline', GREEN, null, 1.5);
    // Ping
    R.fillRoundRect(cardX, iconY + 112, cardW, 40, 6, BLUE);
    R.drawText(cardX + 12, iconY + 120, 'LATENCY', WHITE, null, 1.2);
    R.drawText(cardX + 12, iconY + 136, 'Ping: ' + (Math.floor(Math.random() * 80) + 20) + 'ms', WHITE, null, 1.5);

    // === 底部：服务器描述 MOTD ===
    const motdY = 320;
    R.fillRoundRect(24, motdY, 744, 180, 8, BLACK);
    R.fillRoundRect(28, motdY + 4, 736, 172, 6, WHITE);
    R.drawText(40, motdY + 12, 'SERVER MOTD', BLACK, null, 1.5);
    R.drawHline(40, motdY + 32, 712, BLACK);
    // MOTD 文本（模拟）
    const motd = mc.motd || 'A Minecraft Server\nJoin us for an amazing experience!';
    const lines = motd.split('\n');
    let lineY = motdY + 44;
    for (const line of lines.slice(0, 5)) {
        R.drawText(40, lineY, line, BLUE, null, 1.5);
        lineY += 26;
    }

    // 底部时间戳
    R.drawText(24, 508, formatTimestamp(), BLACK, null, 1);
    R.drawTextRight(768, 508, 'FrameFilm Pro', BLUE, null, 1);
}

function aiPreviewModern(R, ai) {
    const BLACK = 0x00, WHITE = 0x01, YELLOW = 0x02, RED = 0x03, BLUE = 0x05, GREEN = 0x06;
    R.clear(WHITE);
    R.fillRect(0, 0, 6, 528, BLUE);
    R.fillRect(0, 524, 792, 4, GREEN);
    R.fillCircle(772, 20, 8, GREEN);
    R.fillCircle(772, 20, 3, WHITE);
    R.drawTextRight(772, 34, '2/3', BLACK, null, 1);
    R.drawText(24, 28, 'AI', BLACK, null, 5);
    R.drawText(24, 60, ai.label.toUpperCase() + ' · TOKEN', BLUE, null, 1.5);
    R.drawBadge(662, 46, ai.status, WHITE, ai.status === 'OK' ? GREEN : RED);
    // 余额
    const intPart = Math.floor(ai.balance);
    const decPart = (ai.balance - intPart).toFixed(2).slice(1);
    const intStr = intPart.toLocaleString();
    R.fillRect(30, 130, 8, 180, BLUE);
    R.drawText(52, 138, '¥', BLUE, null, 8);
    const symW = R.measureText('¥', 8);
    R.drawText(52 + symW + 8, 130, intStr, BLACK, null, 16);
    const intW = R.measureText(intStr, 16);
    R.drawText(52 + symW + 8 + intW + 8, 192, decPart, GREEN, null, 6);
    R.drawText(52, 318, '◆ TOKEN BALANCE', GREEN, null, 1.5);
    R.drawText(52, 336, 'Sufficient balance available', BLUE, null, 1);
    // 进度
    const usageRatio = Math.min(1, ai.balance / 5000);
    R.drawText(52, 360, 'USAGE', BLACK, null, 1.2);
    R.fillRoundRect(52, 380, 688, 14, 3, BLACK);
    const fillW = Math.max(10, Math.floor(686 * usageRatio));
    R.fillRoundRect(53, 381, fillW, 12, 2, usageRatio > 0.85 ? RED : (usageRatio > 0.7 ? YELLOW : GREEN));
    R.drawText(52, 400, '¥0', BLACK, null, 1);
    R.drawTextRight(740, 400, '¥5,000', BLACK, null, 1);
    let tipColor = GREEN, tip = '◆ BALANCE NORMAL';
    if (ai.balance < 100) { tipColor = RED; tip = '! LOW BALANCE - Please recharge'; }
    else if (ai.balance < 500) { tipColor = YELLOW; tip = '△ BALANCE MODERATE'; }
    R.drawTextCenter(396, 440, tip, tipColor, null, 1.5);
    R.drawText(24, 498, formatTimestamp(), BLACK, null, 1);
    R.drawTextRight(768, 498, ai.label, BLUE, null, 1);
}

function srvPreviewModern(R, srv) {
    const BLACK = 0x00, WHITE = 0x01, YELLOW = 0x02, RED = 0x03, BLUE = 0x05, GREEN = 0x06;
    R.clear(WHITE);
    R.fillRect(0, 0, 6, 528, RED);
    R.fillRect(0, 524, 792, 4, RED);
    const isOnline = srv.status === 'ONLINE';
    R.fillCircle(772, 20, 8, isOnline ? GREEN : RED);
    R.fillCircle(772, 20, 3, WHITE);
    R.drawTextRight(772, 34, '3/3', BLACK, null, 1);
    R.drawText(24, 28, 'SRV', BLACK, null, 5);
    R.drawText(24, 60, srv.label.toUpperCase() + ' · MONITOR', BLUE, null, 1.5);
    R.drawBadge(662, 46, srv.status, WHITE, isOnline ? GREEN : RED);
    // 6卡片
    const padding = 24, gap = 12;
    const cardW = (792 - padding * 2 - gap) / 2;
    const cardH = 92;
    const startY = 110;
    const metrics = [
        { l: 'CPU',    v: srv.cpu + '%',          r: srv.cpu / 100,       c: BLUE,   i: '⬡' },
        { l: 'MEM',    v: srv.mem + '%',          r: srv.mem / 100,       c: GREEN,  i: '◆' },
        { l: 'DISK',   v: srv.disk + '%',         r: srv.disk / 100,      c: YELLOW, i: '◇' },
        { l: 'NET UP', v: srv.netUp + ' MB/s',   r: Math.min(1, srv.netUp / 10),  c: RED,    i: '▲' },
        { l: 'NET DL', v: srv.netDown + ' MB/s', r: Math.min(1, srv.netDown / 20), c: BLUE, i: '▼' },
        { l: 'UPTIME', v: srv.uptime,            r: 0,                   c: GREEN,  i: '◷' },
    ];
    metrics.forEach(function(m, i) {
        const col = i % 2, row = Math.floor(i / 2);
        const x = padding + col * (cardW + gap);
        const y = startY + row * (cardH + gap);
        R.drawRoundRect(x, y, cardW, cardH, 6, WHITE, m.c);
        R.fillRect(x, y, cardW, 22, m.c);
        R.drawText(x + 10, y + 4, m.l + '  ' + m.i, WHITE, null, 1.3);
        R.drawText(x + 10, y + 28, m.v, BLACK, null, 3);
        if (m.r > 0) {
            const barX = x + 10, barY = y + 64, barW = cardW - 20;
            R.fillRoundRect(barX, barY, barW, 10, 3, BLACK);
            const fillW = Math.max(8, Math.floor((barW - 2) * m.r));
            const barColor = m.r > 0.85 ? RED : (m.r > 0.7 ? YELLOW : m.c);
            R.fillRoundRect(barX + 1, barY + 1, fillW, 8, 2, barColor);
        } else {
            R.drawText(x + 10, y + 64, 'Since boot', BLUE, null, 1);
        }
    });
    R.drawText(24, 498, formatTimestamp(), BLACK, null, 1);
    R.drawTextRight(768, 498, srv.label, RED, null, 1);
}

// ===== 服务器监控状态显示 =====
function setSrvStatus(text, isError) {
    var el = document.getElementById('srv-status-text');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#D32F2F' : '#4CAF50';
}
