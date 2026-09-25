import { user_avatar } from '../../../personas.js';

const MODULE = 'profile_styler';
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const MAX_CANVAS_SIDE = 2048;

const defaultSettings = Object.freeze({
    enabled: true,
    fillCorners: true,
    themes: {},
});

const DEFAULT_VALUES = Object.freeze({ zoom: 1, x: 50, y: 50, rot: 0, gray: 0, bright: 100, contrast: 100, sat: 100 });

const ctx = () => SillyTavern.getContext();
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const themeName = () => ctx().powerUserSettings?.theme || '(no theme)';

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE]) all[MODULE] = structuredClone(defaultSettings);
    const s = all[MODULE];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(defaultSettings[key]);
    }
    return s;
}

function migrate() {
    const s = settings();
    delete s.global;
    delete s.perTheme;
    delete s.hiRes;
}

const save = () => ctx().saveSettingsDebounced();

const splitKey = (key) => {
    const i = key.indexOf(':');
    return { kind: key.slice(0, i), file: key.slice(i + 1) };
};

function originalUrl(key) {
    const { kind, file } = splitKey(key);
    return `/${kind === 'persona' ? 'User%20Avatars' : 'characters'}/${encodeURIComponent(file)}`;
}

const cssString = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function imgSelector(key) {
    const { kind, file } = splitKey(key);
    const type = kind === 'persona' ? 'persona' : 'avatar';
    const files = [...new Set([encodeURIComponent(file), encodeURI(file), file])];
    const dirs = kind === 'persona' ? ['User%20Avatars/', 'User Avatars/'] : ['characters/'];
    const parts = [];
    for (const f of files) {
        const q = cssString(`type=${type}&file=${f}`);
        parts.push(`[src$="${q}"]`, `[src*="${q}&"]`);
        for (const d of dirs) {
            const path = cssString(d + f);
            parts.push(`[src$="${path}"]`, `[src*="${path}?"]`);
        }
    }
    return `#chat .mes .avatar img:is(${parts.join(', ')})`;
}

function keyFromImg(img) {
    const raw = img?.getAttribute('src');
    if (!raw) return null;
    let url;
    try {
        url = new URL(raw, location.href);
    } catch {
        return null;
    }
    if (url.pathname.endsWith('/thumbnail')) {
        const file = url.searchParams.get('file');
        const type = url.searchParams.get('type');
        if (!file) return null;
        if (type === 'avatar') return `char:${file}`;
        if (type === 'persona') return `persona:${file}`;
        return null;
    }
    let path;
    try {
        path = decodeURIComponent(url.pathname);
    } catch {
        return null;
    }
    let m = path.match(/\/characters\/([^/]+)$/);
    if (m) return `char:${m[1]}`;
    m = path.match(/\/User Avatars\/([^/]+)$/);
    if (m) return `persona:${m[1]}`;
    return null;
}

const naturalCache = new Map();
function naturalAspect(key, img) {
    const url = originalUrl(key);
    const hit = naturalCache.get(url);
    if (typeof hit === 'number') return hit;
    if (hit === undefined) {
        naturalCache.set(url, null);
        const probe = new Image();
        probe.onload = () => {
            naturalCache.set(url, probe.naturalWidth / probe.naturalHeight);
            queueRender();
        };
        probe.src = url;
    }
    return img?.naturalWidth ? img.naturalWidth / img.naturalHeight : null;
}

const needsCanvas = (p) => !!p.rot || p.bright !== 100 || p.contrast !== 100 || p.sat !== 100;

function outputAspect(ar, rot) {
    const rad = rot * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    if (settings().fillCorners) return sin > cos ? 1 / ar : ar;
    return (ar * cos + sin) / (ar * sin + cos);
}

function imageAspect(key, img, p) {
    const ar = naturalAspect(key, img);
    return ar ? outputAspect(ar, p?.rot || 0) : null;
}

const sourceImages = new Map();
const processed = new Map();
const nativeCanvasFilter = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

function loadSource(key) {
    const url = originalUrl(key);
    if (!sourceImages.has(url)) {
        sourceImages.set(url, new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => {
                sourceImages.delete(url);
                reject(new Error('load'));
            };
            img.src = url;
        }));
    }
    return sourceImages.get(url);
}

function adjustPixels(c, w, h, p) {
    const data = c.getImageData(0, 0, w, h);
    const px = data.data;
    const b = p.bright / 100;
    const k = p.contrast / 100;
    const s = (p.sat / 100) * (1 - p.gray / 100);
    const m = [
        0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
    ];
    for (let i = 0; i < px.length; i += 4) {
        if (!px[i + 3]) continue;
        const r = (px[i] * b - 127.5) * k + 127.5;
        const g = (px[i + 1] * b - 127.5) * k + 127.5;
        const bl = (px[i + 2] * b - 127.5) * k + 127.5;
        px[i] = r * m[0] + g * m[1] + bl * m[2];
        px[i + 1] = r * m[3] + g * m[4] + bl * m[5];
        px[i + 2] = r * m[6] + g * m[7] + bl * m[8];
    }
    c.putImageData(data, 0, 0);
}

function drawProcessed(img, p, fill) {
    const rad = (p.rot || 0) * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    let cw, ch, k;
    if (fill) {
        [cw, ch] = sin > cos ? [h, w] : [w, h];
        k = Math.max((cw * cos + ch * sin) / w, (cw * sin + ch * cos) / h);
    } else {
        cw = w * cos + h * sin;
        ch = w * sin + h * cos;
        k = 1;
    }
    const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(cw, ch));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cw * scale));
    canvas.height = Math.max(1, Math.round(ch * scale));
    const c = canvas.getContext('2d', { willReadFrequently: !nativeCanvasFilter });
    c.imageSmoothingQuality = 'high';
    if (nativeCanvasFilter) {
        c.filter = `brightness(${p.bright}%) contrast(${p.contrast}%) saturate(${p.sat}%) grayscale(${p.gray}%)`;
    }
    c.translate(canvas.width / 2, canvas.height / 2);
    c.rotate(rad);
    c.scale(scale * k, scale * k);
    c.drawImage(img, -w / 2, -h / 2);
    if (!nativeCanvasFilter) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        adjustPixels(c, canvas.width, canvas.height, p);
    }
    const aspect = canvas.width / canvas.height;
    return new Promise((resolve, reject) => canvas.toBlob(
        b => (b ? resolve({ blob: b, aspect }) : reject(new Error('toBlob'))),
        'image/webp',
        0.92,
    ));
}

const signature = (p) => [p.rot || 0, p.bright, p.contrast, p.sat, p.gray, settings().fillCorners ? 1 : 0].join('|');

function requestProcessed(key, p) {
    let entry = processed.get(key);
    if (!entry) processed.set(key, entry = {});
    const sig = signature(p);
    entry.want = { sig, p: { ...p }, fill: settings().fillCorners };
    if (entry.busy || entry.failed === sig) return;
    entry.busy = true;
    (async () => {
        try {
            while (entry.want && entry.want.sig !== entry.sig) {
                const job = entry.want;
                const { blob, aspect } = await drawProcessed(await loadSource(key), job.p, job.fill);
                const old = entry.url;
                entry.url = URL.createObjectURL(blob);
                entry.sig = job.sig;
                entry.aspect = aspect;
                queueRender();
                if (old) setTimeout(() => URL.revokeObjectURL(old), 3000);
            }
        } catch {
            entry.failed = entry.want?.sig;
        } finally {
            entry.busy = false;
        }
    })();
}

function background(key, p) {
    if (!needsCanvas(p)) {
        const ar = naturalCache.get(originalUrl(key));
        return { url: originalUrl(key), aspect: typeof ar === 'number' ? ar : null, baked: false };
    }
    const entry = processed.get(key);
    if (entry?.sig !== signature(p)) requestProcessed(key, p);
    return entry?.url ? { url: entry.url, aspect: entry.aspect, baked: true } : null;
}

function themeProfiles(create = false) {
    const s = settings();
    const name = themeName();
    if (!s.themes[name] && create) s.themes[name] = {};
    return s.themes[name] || {};
}

const getProfile = (key) => {
    const p = themeProfiles()[key];
    return p ? { ...DEFAULT_VALUES, ...p } : null;
};

function setProfile(key, p) {
    const profile = {
        zoom: +clamp(p.zoom, ZOOM_MIN, ZOOM_MAX).toFixed(3),
        x: +clamp(p.x, 0, 100).toFixed(2),
        y: +clamp(p.y, 0, 100).toFixed(2),
        rot: Math.round(clamp(p.rot || 0, -180, 180)),
        gray: +clamp(p.gray, 0, 100).toFixed(1),
        bright: Math.round(clamp(p.bright ?? 100, 0, 200)),
        contrast: Math.round(clamp(p.contrast ?? 100, 0, 200)),
        sat: Math.round(clamp(p.sat ?? 100, 0, 200)),
        fit: p.fit === 'h' ? 'h' : 'w',
    };
    if (typeof p.ba === 'number' && p.ba > 0) profile.ba = p.ba;
    themeProfiles(true)[key] = profile;
    save();
    queueRender();
}

function resetProfile(key) {
    const profiles = themeProfiles();
    delete profiles[key];
    if (!Object.keys(profiles).length) delete settings().themes[themeName()];
    save();
    queueRender();
}

let styleEl = null;
let renderedTheme = null;

const shown = new Map();

function trackShown(key, bg) {
    let entry = shown.get(key);
    if (!entry) {
        shown.set(key, { ...bg, prev: null, timer: 0 });
        return null;
    }
    if (entry.url !== bg.url) {
        entry.prev = entry.url;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            entry.prev = null;
            queueRender();
        }, 700);
    }
    Object.assign(entry, bg);
    return entry.prev;
}

function ruleFor(key, p) {
    let bg = background(key, p);
    if (!bg) {
        const last = shown.get(key);
        if (!last) return '';
        bg = { url: last.url, aspect: last.aspect, baked: last.baked };
    }
    const prev = trackShown(key, bg);
    const sel = imgSelector(key);
    const fit = p.ba && bg.aspect ? (bg.aspect <= p.ba ? 'w' : 'h') : p.fit;
    const z = +(p.zoom * 100).toFixed(2);
    const size = fit === 'h' ? `auto ${z}%` : `${z}% auto`;
    const pos = `${p.x}% ${p.y}%`;
    const images = [bg.url, prev].filter(Boolean).map(u => ({ image: `url("${cssString(u)}")`, blend: 'normal', size, pos }));
    if (!bg.baked && p.gray > 0) {
        const g = p.gray / 100;
        images.unshift({ image: `linear-gradient(hsl(0 0% 50% / ${g}), hsl(0 0% 50% / ${g}))`, blend: 'saturation', size: '100% 100%', pos: '0 0' });
    }
    const join = (k) => images.map(l => l[k]).join(', ');

    return `${sel} {
    object-fit: none !important;
    object-position: -99999px -99999px !important;
    background-image: ${join('image')} !important;
    background-blend-mode: ${join('blend')} !important;
    background-size: ${join('size')} !important;
    background-position: ${join('pos')} !important;
    background-repeat: no-repeat !important;
    background-origin: content-box !important;
    background-clip: content-box !important;
}`;
}

function render() {
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'profile-styler-rules';
        document.head.append(styleEl);
    }
    renderedTheme = themeName();
    const s = settings();
    const rules = s.enabled
        ? Object.keys(themeProfiles()).map(key => ruleFor(key, getProfile(key))).filter(Boolean)
        : [];
    if (editor.open && editor.key) {
        rules.push(`#chat .mes .avatar:has(> ${imgSelector(editor.key).replace('#chat .mes .avatar ', '')}) {
    outline: 2px dashed var(--SmartThemeQuoteColor, #e18a24) !important;
    outline-offset: 2px;
}`);
    }
    const css = rules.join('\n');
    if (styleEl.textContent !== css) styleEl.textContent = css;
}

let renderQueued = false;
function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
        renderQueued = false;
        render();
    });
}

function findImg(key) {
    return document.querySelector(imgSelector(key));
}

function contentBox(img) {
    const cs = getComputedStyle(img);
    return {
        bw: img.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        bh: img.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
    };
}

function measure(key, values) {
    const img = findImg(key);
    if (!img) return { fit: values.fit || 'w', ba: values.ba };
    const { bw, bh } = contentBox(img);
    if (bw <= 0 || bh <= 0) return { fit: values.fit || 'w', ba: values.ba };
    const ba = +(bw / bh).toFixed(4);
    const ar = imageAspect(key, img, values);
    return { fit: ar ? (ar <= ba ? 'w' : 'h') : (values.fit || 'w'), ba };
}

function themeDefaults(key) {
    const values = { ...DEFAULT_VALUES };
    const img = findImg(key);
    if (img) {
        const [px, py] = getComputedStyle(img).objectPosition.split(/\s+/);
        const pct = (v) => (v?.endsWith('%') ? parseFloat(v) : 50);
        values.x = pct(px);
        values.y = pct(py);
    }
    return { ...values, ...measure(key, values) };
}

const currentValues = (key) => getProfile(key) || themeDefaults(key);

function commit(key, values) {
    setProfile(key, { ...values, ...measure(key, values) });
}

const editor = { open: false, key: null, el: null, tab: 'pos' };

const TABS = [
    { id: 'pos', label: '위치' },
    { id: 'edit', label: '편집' },
];

const FIELDS = [
    { id: 'zoom', tab: 'pos', label: '확대', min: ZOOM_MIN, max: ZOOM_MAX, step: 0.01 },
    { id: 'x', tab: 'pos', label: '좌우', min: 0, max: 100, step: 0.5 },
    { id: 'y', tab: 'pos', label: '상하', min: 0, max: 100, step: 0.5 },
    { id: 'rot', tab: 'pos', label: '회전', min: -180, max: 180, step: 1 },
    { id: 'gray', tab: 'edit', label: '흑백', min: 0, max: 100, step: 1 },
    { id: 'bright', tab: 'edit', label: '밝기', min: 0, max: 200, step: 1 },
    { id: 'contrast', tab: 'edit', label: '대비', min: 0, max: 200, step: 1 },
    { id: 'sat', tab: 'edit', label: '채도', min: 0, max: 200, step: 1 },
];

function buildEditor() {
    const tabs = TABS.map(t => `<div class="ps-tab" data-tab="${t.id}">${t.label}</div>`).join('');
    const panes = TABS.map(t => `
        <div class="ps-pane" data-pane="${t.id}">
            ${FIELDS.filter(f => f.tab === t.id).map(f => `
            <div class="ps-row">
                <span>${f.label}</span>
                <input type="range" data-field="${f.id}" min="${f.min}" max="${f.max}" step="${f.step}">
                <input type="number" class="text_pole" data-field="${f.id}" min="${f.min}" max="${f.max}" step="${f.step}">
            </div>`).join('')}
        </div>`).join('');

    const el = document.createElement('div');
    el.id = 'ps_editor';
    el.hidden = true;
    el.innerHTML = `
        <div class="ps-head">
            <i class="fa-solid fa-user-pen"></i>
            <b>프로필 스타일러</b>
            <span class="ps-scope"></span>
            <i class="ps-close fa-solid fa-xmark" title="닫기"></i>
        </div>
        <select class="text_pole ps-target"></select>
        <div class="ps-tabs">${tabs}</div>
        ${panes}
        <div class="ps-buttons">
            <div class="menu_button ps-reset">초기화</div>
            <div class="menu_button ps-done">완료</div>
        </div>`;
    document.body.append(el);
    editor.el = el;

    el.querySelectorAll('.ps-tab').forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
    showTab(editor.tab);

    el.querySelector('.ps-close').addEventListener('click', closeEditor);
    el.querySelector('.ps-done').addEventListener('click', closeEditor);
    el.querySelector('.ps-reset').addEventListener('click', () => {
        if (!editor.key) return;
        resetProfile(editor.key);
        queueMicrotask(() => syncEditor());
    });
    el.querySelector('.ps-target').addEventListener('change', (e) => {
        editor.key = e.target.value || null;
        syncEditor();
        queueRender();
    });
    el.querySelectorAll('input[data-field]').forEach(input => {
        input.addEventListener('input', () => {
            if (!editor.key) return;
            const value = parseFloat(input.value);
            if (Number.isNaN(value)) return;
            commit(editor.key, { ...currentValues(editor.key), [input.dataset.field]: value });
            syncEditor(input);
        });
    });

    makeDraggable(el, el.querySelector('.ps-head'));
}

function showTab(id) {
    editor.tab = id;
    editor.el.querySelectorAll('.ps-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
    editor.el.querySelectorAll('.ps-pane').forEach(p => { p.hidden = p.dataset.pane !== id; });
}

function makeDraggable(panel, handle) {
    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.ps-close')) return;
        const rect = panel.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        handle.setPointerCapture(e.pointerId);
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
        const placed = panel.getBoundingClientRect();
        const ox = placed.left - rect.left;
        const oy = placed.top - rect.top;
        const move = (ev) => {
            panel.style.left = `${clamp(ev.clientX - dx, 0, innerWidth - rect.width) - ox}px`;
            panel.style.top = `${clamp(ev.clientY - dy, 0, innerHeight - rect.height) - oy}px`;
        };
        panel.style.left = `${rect.left - ox}px`;
        panel.style.top = `${rect.top - oy}px`;
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
}

function collectTargets() {
    const { characters, characterId, groupId, groups, chat, powerUserSettings } = ctx();
    const personaName = (file) => powerUserSettings?.personas?.[file] || file;
    const charName = (file) => characters.find(c => c.avatar === file)?.name || file;
    const list = new Map();
    const add = (key, name) => { if (!list.has(key)) list.set(key, name); };

    if (groupId) {
        const group = groups.find(g => g.id === groupId);
        for (const file of group?.members || []) add(`char:${file}`, charName(file));
    } else if (characterId !== undefined && characters[characterId]) {
        const c = characters[characterId];
        add(`char:${c.avatar}`, c.name);
    }
    if (user_avatar) add(`persona:${user_avatar}`, `[페르소나] ${personaName(user_avatar)}`);
    for (const mes of chat || []) {
        if (!mes.is_user || typeof mes.force_avatar !== 'string') continue;
        const key = keyFromImg({ getAttribute: () => mes.force_avatar });
        if (key?.startsWith('persona:')) add(key, `[페르소나] ${personaName(key.slice(8))}`);
    }
    if (editor.key && !list.has(editor.key)) add(editor.key, editor.key.replace(/^\w+:/, ''));
    return [...list].map(([key, name]) => ({ key, name }));
}

function refreshTargetList() {
    const select = editor.el.querySelector('.ps-target');
    const targets = collectTargets();
    if (!editor.key && targets.length) editor.key = targets[0].key;
    select.innerHTML = '';
    if (!targets.length) {
        select.append(new Option('캐릭터를 먼저 선택하세요', ''));
        return;
    }
    for (const t of targets) {
        const label = `${t.name}${themeProfiles()[t.key] ? ' ✎' : ''}`;
        select.append(new Option(label, t.key, false, t.key === editor.key));
    }
}

function syncEditor(skip = null) {
    if (!editor.open) return;
    const scope = `테마: ${themeName()}`;
    const scopeEl = editor.el.querySelector('.ps-scope');
    scopeEl.textContent = scope;
    scopeEl.title = scope;

    if (skip === null) refreshTargetList();

    const values = editor.key ? currentValues(editor.key) : null;
    editor.el.querySelectorAll('input[data-field]').forEach(input => {
        input.disabled = !values;
        if (input !== skip && values) input.value = String(values[input.dataset.field]);
    });
}

function visibleAvatar(key) {
    if (!key) return null;
    const imgs = [...document.querySelectorAll(imgSelector(key))].reverse();
    for (const img of imgs) {
        const r = img.closest('.avatar')?.getBoundingClientRect();
        if (r && r.height > 0 && r.bottom > 0 && r.top < innerHeight) return img.closest('.avatar');
    }
    return null;
}

function placeEditor(anchor) {
    const el = editor.el;
    for (const prop of ['left', 'top', 'bottom', 'transform']) el.style.removeProperty(prop);
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const gap = 8;
    const top = clamp(r.bottom + gap, gap, innerHeight - el.offsetHeight - gap);
    el.style.left = '50%';
    el.style.top = `${top}px`;
    el.style.transform = 'translateX(-50%)';
    const offset = el.getBoundingClientRect().top - top;
    if (Math.abs(offset) > 0.5) el.style.top = `${top - offset}px`;
}

function openEditor(key, anchor) {
    if (!editor.el) buildEditor();
    if (typeof key === 'string') editor.key = key;
    const s = settings();
    if (!s.enabled) {
        s.enabled = true;
        $('#ps_enabled').prop('checked', true);
        save();
    }
    editor.open = true;
    editor.el.hidden = false;
    document.body.classList.add('ps-editing');
    setDirectEditing(true);
    syncEditor();
    placeEditor(anchor instanceof Element ? anchor : visibleAvatar(editor.key));
    queueRender();
}

function closeEditor() {
    editor.open = false;
    if (editor.el) editor.el.hidden = true;
    document.body.classList.remove('ps-editing');
    setDirectEditing(false);
    queueRender();
    $('#ps_count').text(countText());
}

function hitAvatar(e) {
    const img = e.target?.closest?.('#chat .mes .avatar')?.querySelector('img');
    const key = keyFromImg(img);
    return key ? { img, key } : null;
}

function select(key) {
    if (editor.key === key) return;
    editor.key = key;
    syncEditor();
    queueRender();
}

let suppressClickUntil = 0;

function onPointerDown(e) {
    const hit = hitAvatar(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    select(hit.key);

    const start = { ...currentValues(hit.key), ...measure(hit.key, currentValues(hit.key)) };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const { bw, bh } = contentBox(hit.img);
    const ar = imageAspect(hit.key, hit.img, start) || 1;
    const W = start.zoom * (start.fit === 'h' ? bh * ar : bw);
    const H = start.zoom * (start.fit === 'h' ? bh : bw / ar);
    let moved = false;
    document.body.classList.add('ps-dragging');

    const move = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        moved = true;
        const next = { ...start };
        if (W - bw > 0.5) next.x = start.x - (dx / (W - bw)) * 100;
        if (H - bh > 0.5) next.y = start.y - (dy / (H - bh)) * 100;
        setProfile(hit.key, next);
        syncEditor(false);
    };
    const up = () => {
        if (moved) {
            suppressClickUntil = performance.now() + 400;
            syncEditor();
        }
        document.body.classList.remove('ps-dragging');
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', up, true);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
}

function onWheel(e) {
    const hit = hitAvatar(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    select(hit.key);
    const cur = currentValues(hit.key);
    const delta = e.deltaY || e.deltaX;
    if (e.shiftKey) {
        const rot = ((cur.rot + (delta < 0 ? -3 : 3) + 540) % 360) - 180;
        commit(hit.key, { ...cur, rot });
    } else {
        commit(hit.key, { ...cur, zoom: cur.zoom * (delta < 0 ? 1.06 : 1 / 1.06) });
    }
    syncEditor(false);
}

function onClick(e) {
    if (e.target?.closest?.('#ps_editor')) return;
    if (!hitAvatar(e) && performance.now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    e.preventDefault();
    e.stopPropagation();
}

function onKey(e) {
    if (e.key === 'Escape') closeEditor();
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

function onChatPressStart(e) {
    if (editor.open || e.button !== 0 || !e.isPrimary) return;
    const hit = hitAvatar(e);
    if (!hit) return;

    const x0 = e.clientX;
    const y0 = e.clientY;
    let fired = false;

    const timer = setTimeout(() => {
        fired = true;
        suppressClickUntil = performance.now() + 800;
        openEditor(hit.key, hit.img.closest('.avatar'));
        navigator.vibrate?.(15);
    }, LONG_PRESS_MS);

    const move = (ev) => {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > LONG_PRESS_SLOP) end();
    };
    const menu = (ev) => ev.preventDefault();
    const end = () => {
        clearTimeout(timer);
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
        setTimeout(() => window.removeEventListener('contextmenu', menu, true), fired ? 400 : 0);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('contextmenu', menu, true);
}

function setDirectEditing(on) {
    const fn = on ? window.addEventListener : window.removeEventListener;
    fn('pointerdown', onPointerDown, true);
    fn('wheel', onWheel, { capture: true, passive: false });
    fn('click', onClick, true);
    fn('keydown', onKey, true);
}

function countText() {
    return `현재 테마(${themeName()})에 저장된 설정: ${Object.keys(themeProfiles()).length}개`;
}

function buildSettingsPanel() {
    const html = `
    <div class="profile-styler-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>프로필 스타일러</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="ps_enabled">
                    <input type="checkbox" id="ps_enabled">
                    <span>사용</span>
                </label>
                <label class="checkbox_label" for="ps_fill">
                    <input type="checkbox" id="ps_fill">
                    <span>모서리 자동 채우기</span>
                </label>
                <div class="ps-settings-buttons">
                    <div id="ps_open" class="menu_button"><i class="fa-solid fa-user-pen"></i>&nbsp;편집기 열기</div>
                    <div id="ps_wipe" class="menu_button"><i class="fa-solid fa-trash-can"></i>&nbsp;이 테마 설정 전부 삭제</div>
                </div>
                <small id="ps_count"></small>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#ps_enabled').prop('checked', settings().enabled).on('change', function () {
        settings().enabled = this.checked;
        save();
        queueRender();
    });
    $('#ps_fill').prop('checked', settings().fillCorners).on('change', function () {
        settings().fillCorners = this.checked;
        save();
        queueRender();
    });
    $('#ps_open').on('click', openEditor);
    $('#ps_wipe').on('click', async () => {
        const ok = await ctx().Popup.show.confirm('프로필 스타일러', `"${themeName()}" 테마의 모든 캐릭터·페르소나 설정을 지울까요?`);
        if (!ok) return;
        delete settings().themes[themeName()];
        save();
        queueRender();
        syncEditor();
        $('#ps_count').text(countText());
    });
    $('.profile-styler-settings .inline-drawer-toggle').on('click', () => $('#ps_count').text(countText()));
    $('#ps_count').text(countText());
}

function addWandButton() {
    const button = $(`
        <div id="ps_wand_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-user-pen extensionsMenuExtensionButton"></div>
            <span>프로필 스타일러</span>
        </div>`);
    button.on('click', openEditor);
    $('#extensionsMenu').append(button);
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pstyle',
        callback: () => {
            openEditor();
            return '';
        },
        helpString: '<div>프로필 스타일러 편집기를 엽니다.</div>',
    }));
}

jQuery(() => {
    migrate();
    buildSettingsPanel();
    addWandButton();
    registerCommand();
    render();

    document.getElementById('chat')?.addEventListener('pointerdown', onChatPressStart, { passive: true });

    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        if (themeName() === renderedTheme) return;
        render();
        syncEditor();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (!editor.open) return;
        editor.key = null;
        syncEditor();
        queueRender();
    });
});
