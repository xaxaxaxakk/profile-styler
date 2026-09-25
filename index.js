import { user_avatar } from '../../../personas.js';

const MODULE = 'profile_styler';
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;

const defaultSettings = Object.freeze({
    enabled: true,
    themes: {},
});

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
    delete s.global;
    delete s.perTheme;
    delete s.hiRes;
    return s;
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
        probe.onload = () => naturalCache.set(url, probe.naturalWidth / probe.naturalHeight);
        probe.src = url;
    }
    return img?.naturalWidth ? img.naturalWidth / img.naturalHeight : null;
}

function themeProfiles(create = false) {
    const s = settings();
    const name = themeName();
    if (!s.themes[name] && create) s.themes[name] = {};
    return s.themes[name] || {};
}

const getProfile = (key) => themeProfiles()[key] || null;

function setProfile(key, p) {
    themeProfiles(true)[key] = {
        zoom: +clamp(p.zoom, ZOOM_MIN, ZOOM_MAX).toFixed(3),
        x: +clamp(p.x, 0, 100).toFixed(2),
        y: +clamp(p.y, 0, 100).toFixed(2),
        gray: +clamp(p.gray, 0, 100).toFixed(1),
        fit: p.fit === 'h' ? 'h' : 'w',
    };
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

function ruleFor(key, p) {
    const sel = imgSelector(key);
    const url = cssString(originalUrl(key));
    const z = +(p.zoom * 100).toFixed(2);
    const size = p.fit === 'h' ? `auto ${z}%` : `${z}% auto`;
    const layers = p.gray > 0
        ? {
            image: `linear-gradient(hsl(0 0% 50% / ${p.gray / 100}), hsl(0 0% 50% / ${p.gray / 100})), url("${url}")`,
            blend: 'saturation, normal',
            size: `100% 100%, ${size}`,
            pos: `0 0, ${p.x}% ${p.y}%`,
        }
        : { image: `url("${url}")`, blend: 'normal', size, pos: `${p.x}% ${p.y}%` };

    return `${sel} {
    object-fit: none !important;
    object-position: -99999px -99999px !important;
    background-image: ${layers.image} !important;
    background-blend-mode: ${layers.blend} !important;
    background-size: ${layers.size} !important;
    background-position: ${layers.pos} !important;
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
        ? Object.entries(themeProfiles()).map(([key, p]) => ruleFor(key, p))
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

function measureFit(key, fallback = 'w') {
    const img = (findImg(key));
    const ar = naturalAspect(key, img);
    if (!img || !ar) return fallback;
    const { bw, bh } = contentBox(img);
    if (bw <= 0 || bh <= 0) return fallback;
    return ar <= bw / bh ? 'w' : 'h';
}

function themeDefaults(key) {
    let x = 50, y = 50;
    const img = findImg(key);
    if (img) {
        const [px, py] = getComputedStyle(img).objectPosition.split(/\s+/);
        const pct = (v) => (v?.endsWith('%') ? parseFloat(v) : 50);
        x = pct(px);
        y = pct(py);
    }
    return { zoom: 1, x, y, gray: 0, fit: measureFit(key) };
}

const currentValues = (key) => getProfile(key) || themeDefaults(key);

function commit(key, values) {
    setProfile(key, { ...values, fit: measureFit(key, values.fit) });
}

const editor = { open: false, key: null, el: null };

const FIELDS = [
    { id: 'zoom', label: '확대', min: ZOOM_MIN, max: ZOOM_MAX, step: 0.01 },
    { id: 'x', label: '좌우', min: 0, max: 100, step: 0.5 },
    { id: 'y', label: '상하', min: 0, max: 100, step: 0.5 },
    { id: 'gray', label: '흑백', min: 0, max: 100, step: 1 },
];

function buildEditor() {
    const rows = FIELDS.map(f => `
        <div class="ps-row">
            <span>${f.label}</span>
            <input type="range" data-field="${f.id}" min="${f.min}" max="${f.max}" step="${f.step}">
            <input type="number" class="text_pole" data-field="${f.id}" min="${f.min}" max="${f.max}" step="${f.step}">
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
        ${rows}

        <div class="ps-buttons">
            <div class="menu_button ps-reset">초기화</div>
            <div class="menu_button ps-done">완료</div>
        </div>`;
    document.body.append(el);
    editor.el = el;

    el.querySelector('.ps-close').addEventListener('click', closeEditor);
    el.querySelector('.ps-done').addEventListener('click', closeEditor);
    el.querySelector('.ps-reset').addEventListener('click', () => {
        if (!editor.key) return;
        resetProfile(editor.key);
        queueMicrotask(() => syncEditor());
    });
    el.querySelector('.ps-target').addEventListener('change', (e) => {
        editor.key = (e.target).value || null;
        syncEditor();
        queueRender();
    });
    el.querySelectorAll('input[data-field]').forEach(input => {
        input.addEventListener('input', () => {
            if (!editor.key) return;
            const value = parseFloat((input).value);
            if (Number.isNaN(value)) return;
            commit(editor.key, { ...currentValues(editor.key), [input.dataset.field]: value });
            syncEditor(input);
        });
    });

    makeDraggable(el, el.querySelector('.ps-head'));
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
        const label = `${t.name}${getProfile(t.key) ? ' ✎' : ''}`;
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
        toastr.info('프로필 스타일러가 꺼져 있어서 켰어요.');
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

    const start = { ...currentValues(hit.key) };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const { bw, bh } = contentBox(hit.img);
    const ar = naturalAspect(hit.key, hit.img) || 1;
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
        syncEditor((false));
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
    commit(hit.key, { ...cur, zoom: cur.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06) });
    syncEditor((false));
}

function onClick(e) {
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
    fn('wheel', onWheel, ({ capture: true, passive: false }));
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
    settings();
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
