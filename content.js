(function gcalQuickImport() {
  if (window.__gcalQuickImportLoaded) return;
  window.__gcalQuickImportLoaded = true;

  const MAX_FILE_BYTES = 6 * 1024 * 1024;
  const EXPORT_PATH_RE = /\/settings\/export(\/|$)/i;

  function isCalendarMainView() {
    if (!/^\/calendar\/u\/\d+\//i.test(location.pathname)) return false;
    if (EXPORT_PATH_RE.test(location.pathname)) return false;
    // Main grid views: /r, /r/week, /r/month, day URLs, etc.
    return /\/r(\/|$)/i.test(location.pathname) || /\/embed/i.test(location.pathname);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getAccountPrefix() {
    const m = location.pathname.match(/^(\/calendar\/u\/\d+)/);
    return m ? m[1] : '/calendar/u/0';
  }

  function getExportUrl() {
    return `https://calendar.google.com${getAccountPrefix()}/r/settings/export`;
  }

  function isDarkTheme() {
    const bg = getComputedStyle(document.body).backgroundColor;
    const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return false;
    const [r, g, b] = match.slice(1).map(Number);
    return (r + g + b) / 3 < 128;
  }

  function showToast(message, isError = false) {
    let el = document.getElementById('gcal-import-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gcal-import-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('gcal-import-error', isError);
    el.classList.add('gcal-import-visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      el.classList.remove('gcal-import-visible');
    }, isError ? 8000 : 5000);
  }

  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function validateIcsFile(file) {
    if (!file) return { ok: false, error: 'No file' };
    if (file.size === 0) return { ok: false, error: 'File is empty' };
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, error: 'File exceeds 6 MB limit' };
    }
    let name = file.name || 'event.ics';
    const isCsv = /\.csv$/i.test(name);
    if (!isCsv && !/\.(ics|ical|ifb)$/i.test(name)) {
      name = 'event.ics';
    }
    return { ok: true, isCsv, name };
  }

  async function startImport(file) {
    const check = validateIcsFile(file);
    if (!check.ok) {
      showToast(check.error, true);
      return;
    }

    const sample = await file.slice(0, 2048).text();
    if (!check.isCsv && !/BEGIN:VCALENDAR/i.test(sample)) {
      showToast('File does not look like a valid .ics calendar', true);
      return;
    }

    showToast(`Importing ${check.name}…`);

    let fileBase64;
    try {
      fileBase64 = await fileToBase64(file);
    } catch {
      showToast('Could not read file', true);
      return;
    }

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'START_IMPORT',
        fileName: check.name,
        fileType: file.type || (check.isCsv ? 'text/csv' : 'text/calendar'),
        fileBase64,
        exportUrl: getExportUrl()
      });
    } catch (err) {
      showToast('Extension error — reload the page and try again', true);
      console.error('[GCal Quick Import]', err);
      return;
    }

    if (!res?.ok) {
      showToast(res?.error || 'Could not start import', true);
      return;
    }

    if (res.navigateTo) {
      window.location.href = res.navigateTo;
      return;
    }

    showToast('Import running in the background tab…', false);
  }

  // ---------------------------------------------------------------------------
  // Calendar view: floating drop panel
  // ---------------------------------------------------------------------------

  function isFileDrag(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
  }

  let pageDropOverlay = null;
  let pageDropArmed = false;

  function ensurePageDropOverlay() {
    if (!isCalendarMainView()) return;
    if (pageDropOverlay) return;

    pageDropOverlay = document.createElement('div');
    pageDropOverlay.id = 'gcal-import-page-drop';
    pageDropOverlay.innerHTML = `
      <div class="gcal-import-page-drop-inner">
        <strong>Drop calendar file to import</strong>
        <span>.ics or .csv — release to start import</span>
      </div>
    `;
    document.body.appendChild(pageDropOverlay);

    window.addEventListener(
      'dragenter',
      (e) => {
        if (!isFileDrag(e)) return;
        pageDropArmed = true;
        pageDropOverlay.classList.add('gcal-import-page-drop-visible');
        e.preventDefault();
      },
      true
    );

    window.addEventListener(
      'dragover',
      (e) => {
        if (!pageDropArmed || !isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      true
    );

    const hidePageOverlay = () => {
      pageDropArmed = false;
      pageDropOverlay?.classList.remove('gcal-import-page-drop-visible');
    };

    window.addEventListener(
      'dragleave',
      (e) => {
        if (!pageDropArmed) return;
        if (e.clientX <= 0 || e.clientY <= 0) hidePageOverlay();
      },
      true
    );

    window.addEventListener(
      'drop',
      (e) => {
        if (!pageDropArmed || !isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        hidePageOverlay();
        const file = e.dataTransfer?.files?.[0];
        if (file) startImport(file);
      },
      true
    );
  }

  function ensureDropPanel() {
    if (!isCalendarMainView()) return;

    if (document.getElementById('gcal-import-drop-root')) return;

    const root = document.createElement('div');
    root.id = 'gcal-import-drop-root';
    root.innerHTML = `
      <div id="gcal-import-drop-panel">
        <p id="gcal-import-drop-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v12m0 0l4-4m-4 4l-4-4M5 21h14" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Import events
        </p>
        <p id="gcal-import-drop-hint">Drop an .ics file here</p>
        <div id="gcal-import-drop-actions">
          <button type="button" id="gcal-import-browse-btn">Choose file</button>
        </div>
        <input type="file" id="gcal-import-file-input" accept=".ics,.ical,.ifb,.csv,text/calendar,text/csv" hidden />
      </div>
    `;

    document.body.appendChild(root);

    const fileInput = document.getElementById('gcal-import-file-input');
    const panelEl = document.getElementById('gcal-import-drop-panel');
    const browseBtn = document.getElementById('gcal-import-browse-btn');

    function syncTheme() {
      root.classList.toggle('gcal-import-theme-dark', isDarkTheme());
    }
    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style']
    });

    browseBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) startImport(file);
    });

    ['dragenter', 'dragover'].forEach((type) => {
      panelEl.addEventListener(type, (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        root.classList.add('gcal-import-dragging');
        e.dataTransfer.dropEffect = 'copy';
      });
    });

  panelEl.addEventListener('dragleave', (e) => {
      if (!panelEl.contains(e.relatedTarget)) {
        root.classList.remove('gcal-import-dragging');
      }
    });

    panelEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.classList.remove('gcal-import-dragging');
      const file = e.dataTransfer?.files?.[0];
      if (file) startImport(file);
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'IMPORT_DONE') {
      if (message.ok) {
        const cal = message.calendarName ? ` → ${message.calendarName}` : '';
        showToast(`Imported: ${message.statusText || message.fileName}${cal}`);
      } else {
        showToast(message.statusText || 'Import failed', true);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Settings / export page automation
  // ---------------------------------------------------------------------------

  function extractJobIdFromHash() {
    const match = location.hash.match(/gcal-import-job=([^&]+)/);
    if (!match) return null;
    const jobId = decodeURIComponent(match[1]);
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      // ignore
    }
    return jobId;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function collectFileInputs(root = document, acc = []) {
    if (!root?.querySelectorAll) return acc;
    for (const el of root.querySelectorAll('input[type="file"]')) acc.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) collectFileInputs(el.shadowRoot, acc);
    }
    return acc;
  }

  function scoreFileInput(input) {
    let score = 0;
    const accept = (input.getAttribute('accept') || '').toLowerCase();
    if (/(ics|ical|csv)/i.test(accept)) score += 30;
    if (input.closest('[role="main"], main')) score += 20;
    return score;
  }

  function findFileInput() {
    const inputs = collectFileInputs();
    if (!inputs.length) return null;
    return inputs.sort((a, b) => scoreFileInput(b) - scoreFileInput(a))[0];
  }

  function isButtonEnabled(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    return getComputedStyle(btn).pointerEvents !== 'none';
  }

  function findImportButton(container) {
    const root = container || document;
    const buttons = Array.from(root.querySelectorAll('button, [role="button"]'));
    const exportRe = /export/i;
    return (
      buttons.find((btn) => {
        if (!isVisible(btn)) return false;
        const text = (btn.innerText || btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        const label = `${text} ${aria}`.trim();
        if (exportRe.test(label)) return false;
        return /^import\b/i.test(label) || /\bimport\b/i.test(aria);
      }) || null
    );
  }

  function findImportSection(fileInput) {
    let node = fileInput?.parentElement;
    while (node && node !== document.body) {
      if (findImportButton(node)) return node;
      node = node.parentElement;
    }
    return document.querySelector('[role="main"]') || document.body;
  }

  function base64ToFile(fileBase64, fileName, fileType) {
    const binary = atob(fileBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const type = fileType || (/\.csv$/i.test(fileName) ? 'text/csv' : 'text/calendar');
    return new File([bytes], fileName, { type, lastModified: Date.now() });
  }

  function attachFileToInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, dt.files);
    else input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function fileLooksAttached(sectionRoot, fileName) {
    const root = sectionRoot || document;
    const btn = findImportButton(root);
    if (btn && isButtonEnabled(btn)) return true;
    if (fileName) {
      return (root.innerText || '').toLowerCase().includes(fileName.toLowerCase());
    }
    return false;
  }

  async function attachFile(fileBase64, fileName, fileType) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const main = await chrome.runtime.sendMessage({
          type: 'ATTACH_FILE_MAIN_WORLD',
          fileBase64,
          fileName,
          fileType
        });
        if (main?.ok) {
          await sleep(400);
          const section = findImportSection(findFileInput());
          if (fileLooksAttached(section, fileName)) return { ok: true };
        }
      } catch {
        // Background may be waking up.
      }

      const input = findFileInput();
      if (input) {
        attachFileToInput(input, base64ToFile(fileBase64, fileName, fileType));
        await sleep(400);
        const section = findImportSection(input);
        if (fileLooksAttached(section, fileName)) return { ok: true, input };
      }
      await sleep(350);
    }
    return { ok: false };
  }

  async function waitForEnabledImportButton(sectionRoot, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const btn = findImportButton(sectionRoot);
      if (btn && isButtonEnabled(btn)) return btn;
      await sleep(300);
    }
    return null;
  }

  function findCalendarDropdown(sectionRoot) {
    const root = sectionRoot || document;
    const select = root.querySelector('select');
    if (select && isVisible(select)) return { kind: 'select', el: select };
    const combo = Array.from(root.querySelectorAll('[role="combobox"]')).find(isVisible);
    if (combo) return { kind: 'custom', el: combo };
    return null;
  }

  function readSelectedCalendar(dropdown) {
    if (!dropdown?.el) return '';
    if (dropdown.kind === 'select') {
      const opt = dropdown.el.options[dropdown.el.selectedIndex];
      return opt ? opt.textContent.trim() : '';
    }
    const selected = dropdown.el.querySelector('[aria-selected="true"]');
    if (selected) return selected.textContent.trim();
    return (dropdown.el.innerText || '').trim().split('\n')[0] || '';
  }

  function clickEl(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  async function selectCalendar(sectionRoot, targetName) {
    if (!targetName) return { ok: true, selectedName: readSelectedCalendar(findCalendarDropdown(sectionRoot)) };

    const dropdown = findCalendarDropdown(sectionRoot);
    if (!dropdown) return { ok: false, error: 'Calendar dropdown not found' };

    const want = targetName.trim().toLowerCase();

    if (dropdown.kind === 'select') {
      const match = Array.from(dropdown.el.options).find((o) =>
        o.textContent.trim().toLowerCase().includes(want)
      );
      if (!match) return { ok: false, error: `Calendar not found: ${targetName}` };
      dropdown.el.value = match.value;
      dropdown.el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selectedName: match.textContent.trim() };
    }

    clickEl(dropdown.el);
    await sleep(200);
    const options = Array.from(document.querySelectorAll('[role="option"]')).filter(isVisible);
    const match = options.find((o) => (o.innerText || '').trim().toLowerCase().includes(want));
    if (!match) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false, error: `Calendar not found: ${targetName}` };
    }
    const name = (match.innerText || '').trim();
    clickEl(match);
    await sleep(200);
    return { ok: true, selectedName: name };
  }

  function collectStatusTexts() {
    const texts = new Set();
    for (const el of document.querySelectorAll('[role="alertdialog"], [role="dialog"], [role="alert"], [role="status"]')) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t) texts.add(t);
    }
    return texts;
  }

  function meaningfulResult(text) {
    return /(imported|events?|could not|unable|failed|error|out of)/i.test(text || '');
  }

  async function waitForImportResult(baseline, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const text of collectStatusTexts()) {
        if (meaningfulResult(text) && !baseline.has(text)) {
          return { ok: !/(could not|unable|failed|error|0 out of)/i.test(text), text };
        }
      }
      await sleep(400);
    }
    return { ok: false, text: 'Timed out waiting for import confirmation' };
  }

  async function runExportJob(job) {
    const report = (extra) =>
      chrome.runtime.sendMessage({
        type: 'IMPORT_FINISHED',
        sourceTabId: job.sourceTabId,
        fileName: job.fileName,
        ...extra
      });

    await sleep(1200);
    const attach = await attachFile(job.fileBase64, job.fileName, job.fileType);
    if (!attach.ok) {
      if (job.mode === 'pick') {
        showToast('File input not ready — attach the file manually and click Import', true);
        return;
      }
      await report({ ok: false, statusText: 'Import file input not found', keepTabOpen: true });
      return;
    }

    const section = findImportSection(findFileInput());
    await sleep(400);

    if (job.mode === 'pick') {
      showToast(`File ready: ${job.fileName}. Choose calendar and click Import.`);
      return;
    }

    const pick = await selectCalendar(section, job.defaultCalendarName);
    if (!pick.ok) {
      await report({ ok: false, statusText: pick.error, keepTabOpen: true });
      return;
    }

    const importBtn = await waitForEnabledImportButton(section);
    if (!importBtn) {
      await report({
        ok: false,
        statusText: 'Import button not ready (file may not be attached)',
        keepTabOpen: true
      });
      return;
    }

    const baseline = collectStatusTexts();
    clickEl(importBtn);

    const result = await waitForImportResult(baseline);
    await report({
      ok: result.ok,
      statusText: result.text,
      calendarName: pick.selectedName,
      keepTabOpen: !result.ok
    });

    const dismiss = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) =>
      /^(ok|close|done)$/i.test((b.innerText || '').trim())
    );
    if (dismiss) clickEl(dismiss);
  }

  async function maybeRunExportAutomation() {
    if (!EXPORT_PATH_RE.test(location.pathname)) return;
    const jobIdFromHash = extractJobIdFromHash();

    const waited = await (async () => {
      for (let i = 0; i < 60; i++) {
        const lookup = await chrome.runtime.sendMessage({
          type: 'LOOKUP_JOB_FOR_TAB',
          jobIdHint: jobIdFromHash || null
        });
        if (lookup?.job) {
          const consumed = await chrome.runtime.sendMessage({
            type: 'CONSUME_JOB',
            jobIdHint: lookup.job.jobId
          });
          if (consumed?.job) return consumed.job;
        }
        await sleep(300);
      }
      return null;
    })();

    if (!waited) return;
    runExportJob(waited).catch((err) => {
      console.error('[GCal Quick Import]', err);
      chrome.runtime.sendMessage({
        type: 'IMPORT_FINISHED',
        sourceTabId: waited.sourceTabId,
        ok: false,
        statusText: String(err?.message || err),
        fileName: waited.fileName,
        keepTabOpen: true
      });
    });
  }

  ensureDropPanel();
  ensurePageDropOverlay();
  maybeRunExportAutomation();

  // Google Calendar is a SPA; re-mount panel after client-side navigation.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      ensureDropPanel();
      ensurePageDropOverlay();
      maybeRunExportAutomation();
    }
  }, 1000);
})();